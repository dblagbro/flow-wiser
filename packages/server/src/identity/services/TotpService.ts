import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { DataSource, IsNull, Repository } from 'typeorm'
import { EncryptionAlgorithm } from '../../database/entities/identity/EncryptionMetadata'
import { AuditOutcome, AuditSubjectType } from '../../database/entities/identity/AuditEvent'
import { MfaFactor, MfaFactorStatus, MfaFactorType } from '../../database/entities/identity/MfaFactor'
import logger from '../../utils/logger'
import { decryptToBuffer, encrypt, EncryptionMetadataFields } from '../crypto/aead'
import { getKeyring, Keyring } from '../crypto/keyring'
import { AuditService } from './AuditService'
import { MfaActorContext, MfaAuditAction } from './MfaPolicyService'

/**
 * Identity — TotpService (requirements §8 "TOTP (RFC 6238) as the baseline second factor").
 *
 * ── No library, and why that is not a compromise ─────────────────────────────────────────────
 * `otplib` and `speakeasy` are not added, because this work adds no new runtime dependency — the
 * same constraint that put bcrypt rather than argon2id in `crypto/passwords.ts` and AES-256-GCM
 * rather than XChaCha20-Poly1305 in `crypto/aead.ts`. It costs very little here: RFC 6238 is
 * HMAC-SHA1 over an 8-byte counter plus RFC 4226's dynamic truncation, and `node:crypto` provides
 * the HMAC. What is NOT delegated to a library is also what is not inherited from one — this
 * implementation is checked directly against the RFC 6238 published test vectors (Appendix B), for
 * SHA-1, SHA-256 and SHA-512, which is a stronger statement than "we imported something popular".
 *
 * Base32 (RFC 4648 §6) is ~20 lines and is here for the same reason: it is the wire format for the
 * shared secret in the `otpauth://` URI that every authenticator app scans.
 *
 * ── The three properties that make a TOTP implementation safe rather than merely correct ─────
 *  1. **A ±1 step window.** Clocks drift and users type slowly, so the step before and the step
 *     after are accepted. Wider windows are a common and quiet weakening: each extra step
 *     multiplies the number of codes valid at any instant, so the window is a constant here rather
 *     than an environment variable someone can widen without review.
 *  2. **Constant-time comparison, over the WHOLE window.** `timingSafeEqual` on each candidate,
 *     and the loop never breaks early — an early exit would leak WHICH step matched, which is a
 *     read on the verifier's clock offset relative to the user's.
 *  3. **Replay prevention.** A code is valid for 30 seconds; without a replay guard, a code
 *     observed over the shoulder, in a phishing proxy or in a log line can be used again inside
 *     that window. See {@link TotpService.verify} for how the last accepted step is tracked and why
 *     it needs no new column.
 *
 * ── The secret is encrypted at rest, not hashed ──────────────────────────────────────────────
 * Requirements §9 lists "MFA/TOTP seeds" among the values encrypted at rest, and `MfaFactor.ts`
 * explains why it cannot be hashed: verification recomputes HMAC(secret, step), which needs the
 * secret back. So it goes through `crypto/aead.ts` and writes the five EncryptionMetadata columns
 * the entity defines — key id, key version, algorithm, nonce, salt — which is what makes a seed
 * re-keyable by §9's rotation pass without any user re-enrolling.
 *
 * ── Enrolment is two-phase ───────────────────────────────────────────────────────────────────
 * `pending` on creation, `confirmed` only after one correct code (§8: "enrolment with QR
 * provisioning URI, verification"). A pending factor never satisfies policy — `MfaFactor.ts` gives
 * the attack it prevents: if it did, starting an enrolment and abandoning it would be a bypass.
 */

// ── RFC 6238 / RFC 4226 parameters ───────────────────────────────────────────────────────────

/**
 * 160 bits. RFC 4226 §4 R6 requires at least 128 bits of shared secret and RECOMMENDS 160, which is
 * also the HMAC-SHA1 output width, so nothing is truncated. Every authenticator app accepts it.
 */
export const TOTP_SECRET_BYTES = 20

/** RFC 6238 §4 default time step, and the value every authenticator app assumes. */
export const TOTP_PERIOD_SECONDS = 30

/** RFC 4226 §5.3 — 6 digits is the interoperable default. */
export const TOTP_DIGITS = 6

/** RFC 6238 permits SHA-1/256/512. SHA-1 is the default because it is what the apps implement. */
export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512'
export const TOTP_ALGORITHM: TotpAlgorithm = 'sha1'

/**
 * Steps accepted either side of the current one — RFC 6238 §5.2's "one time step backward" plus one
 * forward for a client clock that runs fast. Three codes are live at any instant.
 *
 * A constant, NOT configuration: widening it is a security decision, and the failure it appears to
 * fix (a user whose phone is minutes out of sync) is a clock problem that widening only hides.
 */
export const TOTP_WINDOW_STEPS = 1

/** RFC 4648 §6. Uppercase, no padding — the form every `otpauth://` consumer expects. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Raised for malformed input to the TOTP primitives. Never carries the secret or the code. */
export class TotpError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'TotpError'
    }
}

// ── Base32 (RFC 4648 §6) ─────────────────────────────────────────────────────────────────────

/**
 * Encode bytes as unpadded uppercase base32.
 *
 * A rolling bit accumulator: shift each byte in, emit a symbol whenever five bits are available.
 * `value` never holds more than 12 bits (at most 4 left over, plus 8 shifted in), so the 32-bit
 * integer arithmetic JavaScript's bitwise operators use cannot overflow.
 */
export const base32Encode = (bytes: Buffer | Uint8Array): string => {
    let bits = 0
    let value = 0
    let encoded = ''
    for (const byte of bytes) {
        value = (value << 8) | byte
        bits += 8
        while (bits >= 5) {
            encoded += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
            bits -= 5
        }
    }
    // Left-over bits are left-aligned into a final symbol. Padding is omitted: RFC 4648 permits it
    // and the `otpauth://` ecosystem universally uses the unpadded form.
    if (bits > 0) encoded += BASE32_ALPHABET[(value << (5 - bits)) & 31]
    return encoded
}

/**
 * Decode base32 back to bytes.
 *
 * Deliberately permissive about PRESENTATION and strict about CONTENT: whitespace, hyphens,
 * lowercase and trailing `=` padding are all accepted, because users retype secrets from a screen
 * where they are printed in readable groups. An out-of-alphabet character is rejected outright —
 * silently skipping it would decode a mistyped secret into a valid-looking but wrong key, and the
 * user would then see "invalid code" forever with nothing to indicate why.
 */
export const base32Decode = (encoded: string): Buffer => {
    if (typeof encoded !== 'string') throw new TotpError('secret must be a base32 string')
    const normalised = encoded.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase()
    if (normalised.length === 0) throw new TotpError('secret is empty')

    let bits = 0
    let value = 0
    const bytes: number[] = []
    for (const symbol of normalised) {
        const index = BASE32_ALPHABET.indexOf(symbol)
        if (index === -1) throw new TotpError('secret is not valid base32')
        value = (value << 5) | index
        bits += 5
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 255)
            bits -= 8
        }
    }
    return Buffer.from(bytes)
}

// ── RFC 4226 / RFC 6238 ──────────────────────────────────────────────────────────────────────

/** A base32 string or the raw seed bytes. Both are accepted so callers holding bytes need not round-trip through a string. */
export type TotpSecret = string | Buffer

const toSecretBytes = (secret: TotpSecret): Buffer => (Buffer.isBuffer(secret) ? secret : base32Decode(secret))

/**
 * HOTP (RFC 4226 §5.3): HMAC over the big-endian 8-byte counter, then dynamic truncation.
 *
 * The offset is the low nibble of the LAST byte of the digest; four bytes are read from there, the
 * top bit is masked off (so the result is positive on every platform, RFC 4226's stated reason),
 * and the value is reduced mod 10^digits and zero-padded.
 *
 * `writeBigUInt64BE` rather than two 32-bit writes: RFC 6238's own test vectors include
 * T = 20000000000, whose counter is fine in 32 bits but whose SECONDS value is not, and the BigInt
 * path removes any question of precision at the boundary.
 */
export const hotp = (
    secret: TotpSecret,
    counter: number,
    digits: number = TOTP_DIGITS,
    algorithm: TotpAlgorithm = TOTP_ALGORITHM
): string => {
    if (!Number.isInteger(counter) || counter < 0) throw new TotpError('counter must be a non-negative integer')
    const counterBytes = Buffer.alloc(8)
    counterBytes.writeBigUInt64BE(BigInt(counter))

    const digest = createHmac(algorithm, toSecretBytes(secret)).update(counterBytes).digest()
    const offset = digest[digest.length - 1] & 0x0f
    const binary =
        ((digest[offset] & 0x7f) << 24) |
        ((digest[offset + 1] & 0xff) << 16) |
        ((digest[offset + 2] & 0xff) << 8) |
        (digest[offset + 3] & 0xff)

    return String(binary % 10 ** digits).padStart(digits, '0')
}

/** The time step for an instant — RFC 6238 §4.2's `T = (Current Unix time - T0) / X`, with T0 = 0. */
export const timeStepAt = (epochMs: number, period: number = TOTP_PERIOD_SECONDS): number => Math.floor(epochMs / 1000 / period)

/** The code for a given step. Exposed so the RFC 6238 vectors can be checked against it directly. */
export const totpAtStep = (
    secret: TotpSecret,
    step: number,
    digits: number = TOTP_DIGITS,
    algorithm: TotpAlgorithm = TOTP_ALGORITHM
): string => hotp(secret, step, digits, algorithm)

/** Why a presented code was not accepted. Stable, snake_case, safe to switch on and to audit. */
export enum TotpRejection {
    /** Not `digits` decimal digits. Rejected before any HMAC work — nothing to compare. */
    MALFORMED = 'malformed',
    /** No step in the window produced this code. */
    MISMATCH = 'mismatch',
    /** The code is arithmetically correct but its step has already been spent. See {@link TotpService.verify}. */
    REPLAYED = 'replayed'
}

export interface TotpVerifyOptions {
    /** Instant to evaluate against. Injectable so the RFC vectors and the replay tests are deterministic. */
    nowMs?: number
    period?: number
    digits?: number
    algorithm?: TotpAlgorithm
    /** Steps accepted either side of the current one. Defaults to {@link TOTP_WINDOW_STEPS}. */
    window?: number
    /**
     * The highest step already spent by this factor, or null if none. Any match at or below it is
     * {@link TotpRejection.REPLAYED} — this is the pure half of the replay guard; the durable half
     * is in {@link TotpService.verify}.
     */
    lastAcceptedStep?: number | null
}

export type TotpVerification = { valid: true; step: number } | { valid: false; reason: TotpRejection; step: number | null }

/**
 * Verify a presented code against a secret. Pure — no clock of its own beyond `Date.now()`, no
 * database, no state.
 *
 * Every step in the window is evaluated with {@link timingSafeEqual} and the loop DOES NOT BREAK on
 * a match. Both properties matter and for different reasons: `timingSafeEqual` stops a byte-by-byte
 * comparison from revealing how much of a guessed code was right, and running the full window stops
 * the response time from revealing which step matched — which would disclose the verifier's clock
 * offset from the user's, and with it the exact instant to replay a captured code.
 */
export const verifyCode = (secret: TotpSecret, code: string, options: TotpVerifyOptions = {}): TotpVerification => {
    const digits = options.digits ?? TOTP_DIGITS
    const period = options.period ?? TOTP_PERIOD_SECONDS
    const algorithm = options.algorithm ?? TOTP_ALGORITHM
    const window = options.window ?? TOTP_WINDOW_STEPS

    const presented = typeof code === 'string' ? code.replace(/[\s-]/g, '') : ''
    // A malformed code is not a cryptographic event and gets no constant-time treatment: its length
    // and character class are already known to whoever typed it.
    if (!new RegExp(`^\\d{${digits}}$`).test(presented)) return { valid: false, reason: TotpRejection.MALFORMED, step: null }

    const current = timeStepAt(options.nowMs ?? Date.now(), period)
    const presentedBuffer = Buffer.from(presented, 'utf8')
    let matchedStep: number | null = null

    for (let offset = -window; offset <= window; offset++) {
        const step = current + offset
        if (step < 0) continue
        const expected = Buffer.from(totpAtStep(secret, step, digits, algorithm), 'utf8')
        // Lengths are equal by construction (both are `digits` ASCII characters); the guard exists
        // because timingSafeEqual THROWS on a mismatch, and an exception path is itself a timing
        // signal.
        const equal = expected.length === presentedBuffer.length && timingSafeEqual(expected, presentedBuffer)
        // No `break`: see the doc comment. The last match wins, which for a sane window is the only
        // match — two steps producing the same 6 digits is a 1-in-a-million coincidence and picking
        // the later one is the conservative choice for the replay watermark.
        if (equal) matchedStep = step
    }

    if (matchedStep === null) return { valid: false, reason: TotpRejection.MISMATCH, step: null }
    if (options.lastAcceptedStep !== null && options.lastAcceptedStep !== undefined && matchedStep <= options.lastAcceptedStep) {
        return { valid: false, reason: TotpRejection.REPLAYED, step: matchedStep }
    }
    return { valid: true, step: matchedStep }
}

// ── Provisioning ─────────────────────────────────────────────────────────────────────────────

export interface ProvisioningUriInput {
    /** base32, as shown to the user. */
    secret: string
    /** Usually the email address. Rendered as the account label in the authenticator app. */
    accountName: string
    /** The instance's name. Rendered as the issuer, so a user with several accounts can tell them apart. */
    issuer?: string
    digits?: number
    period?: number
    algorithm?: TotpAlgorithm
}

/**
 * The `otpauth://totp/...` URI a QR code encodes (§8: "enrolment with QR provisioning URI").
 *
 * The label is `issuer:account` AND `issuer` is repeated as a query parameter — both, because the
 * de-facto Key URI format specifies the parameter while several widely used apps only read the
 * label prefix. Every component is percent-encoded; an issuer containing a colon would otherwise
 * split the label and silently mis-attribute the account.
 *
 * `algorithm`, `digits` and `period` are always emitted rather than left to default. The defaults
 * are near-universal but not guaranteed, and an app that guesses differently produces codes that
 * never verify — a failure that looks exactly like a wrong secret.
 */
export const provisioningUri = (input: ProvisioningUriInput): string => {
    const issuer = input.issuer ?? process.env.IDENTITY_MFA_ISSUER ?? 'Flow-Wiser'
    const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(input.accountName)}`
    const parameters = new URLSearchParams({
        secret: input.secret,
        issuer,
        algorithm: (input.algorithm ?? TOTP_ALGORITHM).toUpperCase(),
        digits: String(input.digits ?? TOTP_DIGITS),
        period: String(input.period ?? TOTP_PERIOD_SECONDS)
    })
    return `otpauth://totp/${label}?${parameters.toString()}`
}

/** A fresh 160-bit secret in both the forms the caller needs: bytes to store, base32 to display. */
export const generateSecret = (): { bytes: Buffer; base32: string } => {
    const bytes = randomBytes(TOTP_SECRET_BYTES)
    return { bytes, base32: base32Encode(bytes) }
}

// ── Service ──────────────────────────────────────────────────────────────────────────────────

/** What enrolment hands back. `secret` and `provisioningUri` are shown ONCE and never retrievable again. */
export interface TotpEnrolment {
    factorId: string
    /** base32, for manual entry when a camera is not available. */
    secret: string
    provisioningUri: string
    digits: number
    period: number
    algorithm: TotpAlgorithm
}

/** A factor as it is safe to render — no secret, no metadata that hints at one. */
export interface TotpFactorSummary {
    id: string
    type: MfaFactorType
    label: string | null
    status: MfaFactorStatus
    createdDate: Date
    confirmedDate: Date | null
    lastUsedDate: Date | null
}

export type TotpVerifyResult =
    | { ok: true; factorId: string; step: number }
    | { ok: false; reason: TotpRejection | 'no_confirmed_factor' | 'race_lost' }

export interface TotpServiceOptions {
    /** Omit in the running server; it resolves `AppDataSource` lazily, exactly like the other services do. */
    dataSource?: DataSource
    audit?: AuditService
    keyring?: Keyring
    /** Injectable clock. Tests only — the running server always uses `Date.now`. */
    now?: () => number
}

export class TotpService {
    private readonly injectedDataSource?: DataSource
    private readonly audit: AuditService
    private readonly injectedKeyring?: Keyring
    private readonly now: () => number

    constructor(options: TotpServiceOptions = {}) {
        this.injectedDataSource = options.dataSource
        this.audit = options.audit ?? new AuditService({ dataSource: options.dataSource })
        this.injectedKeyring = options.keyring
        this.now = options.now ?? (() => Date.now())
    }

    /** Lazy `require` for the same reason SessionService uses one: a static import would drag in the server entrypoint. */
    private getDataSource(): DataSource {
        if (this.injectedDataSource) return this.injectedDataSource
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { getRunningExpressApp } = require('../../utils/getRunningExpressApp')
        return getRunningExpressApp().AppDataSource
    }

    private repo(): Repository<MfaFactor> {
        return this.getDataSource().getRepository(MfaFactor)
    }

    private keyring(): Keyring {
        return this.injectedKeyring ?? getKeyring()
    }

    /**
     * Columns needed to VERIFY. `secret` is `select: false` on the entity, so it has to be named
     * explicitly — which is the entity's point: loading the seed takes deliberate effort, so no
     * incidental `find()` can carry it into a response or a log line (§9).
     */
    private static readonly VERIFY_SELECT = {
        id: true,
        userId: true,
        type: true,
        status: true,
        secret: true,
        secretKeyId: true,
        secretKeyVersion: true,
        secretAlgorithm: true,
        secretNonce: true,
        secretSalt: true,
        lastUsedDate: true,
        confirmedDate: true,
        createdDate: true,
        label: true
    } as const

    /** Reassemble the five EncryptionMetadata columns and decrypt. Fails closed — a partial row is not a seed. */
    private decryptSecret(factor: MfaFactor): Buffer {
        if (!factor.secret) throw new TotpError(`MFA factor ${factor.id} has no stored secret`)
        if (!factor.secretNonce || !factor.secretSalt || !factor.secretAlgorithm || factor.secretKeyVersion === null) {
            throw new TotpError(`MFA factor ${factor.id} is missing encryption metadata and cannot be decrypted`)
        }
        const meta: EncryptionMetadataFields = {
            keyId: factor.secretKeyId ?? '',
            keyVersion: factor.secretKeyVersion as number,
            algorithm: factor.secretAlgorithm as EncryptionAlgorithm,
            nonce: factor.secretNonce,
            salt: factor.secretSalt
        }
        return decryptToBuffer(factor.secret, meta, this.keyring())
    }

    /**
     * Phase one of enrolment: generate a secret, store it ENCRYPTED, and hand back the provisioning
     * URI. The factor is `pending` and satisfies nothing until {@link confirm} succeeds.
     *
     * Any earlier `pending` factor for the same user is deleted first. Abandoned enrolments would
     * otherwise pile up — a user who scans, fails, and restarts leaves a row holding a live secret
     * that nobody will ever confirm, and every one of those is a seed sitting in the database for
     * no reason. Confirmed factors are untouched: §8's model is several authenticators per user
     * (MfaFactor.ts), so enrolling a second device must not disturb the first.
     */
    async enrol(input: {
        userId: string
        /** The authenticator label shown in the app — normally the user's email address. */
        accountName: string
        /** User-supplied device name ("iPhone", "1Password"). Recognition only. */
        label?: string | null
        issuer?: string
        context?: MfaActorContext
    }): Promise<TotpEnrolment> {
        const { bytes, base32 } = generateSecret()
        let encrypted
        try {
            encrypted = encrypt(bytes, this.keyring())
        } finally {
            // The plaintext seed has been handed to AEAD; drop our copy rather than leave it for a
            // core dump. The base32 form still exists as a JS string that cannot be zeroed — it has
            // to, because the user must see it — and that is exactly why it is returned and never
            // stored.
            bytes.fill(0)
        }

        await this.repo().delete({ userId: input.userId, status: MfaFactorStatus.PENDING })

        const factor = this.repo().create({
            userId: input.userId,
            type: MfaFactorType.TOTP,
            label: input.label ?? null,
            secret: encrypted.ciphertext,
            secretKeyId: encrypted.keyId,
            secretKeyVersion: encrypted.keyVersion,
            secretAlgorithm: encrypted.algorithm,
            secretNonce: encrypted.nonce,
            secretSalt: encrypted.salt,
            status: MfaFactorStatus.PENDING,
            confirmedDate: null,
            lastUsedDate: null
        })
        const saved = await this.repo().save(factor)

        await this.audit.record({
            action: MfaAuditAction.ENROL_START,
            outcome: AuditOutcome.SUCCESS,
            subject: this.subject(input.context, input.userId),
            target: { type: 'mfa_factor', id: saved.id },
            scope: { organizationId: input.context?.organizationId ?? null, workspaceId: input.context?.workspaceId ?? null },
            route: input.context?.route ?? null,
            ipAddress: input.context?.ipAddress ?? null,
            userAgent: input.context?.userAgent ?? null,
            // By reference, never by value (§10). There is no parameter here that could carry the seed.
            detail: { factorType: MfaFactorType.TOTP, label: input.label ?? null },
            message: `TOTP enrolment started for user ${input.userId}`
        })

        return {
            factorId: saved.id,
            secret: base32,
            provisioningUri: provisioningUri({ secret: base32, accountName: input.accountName, issuer: input.issuer }),
            digits: TOTP_DIGITS,
            period: TOTP_PERIOD_SECONDS,
            algorithm: TOTP_ALGORITHM
        }
    }

    /**
     * Phase two: one correct code promotes `pending` to `confirmed`.
     *
     * The promotion is a CONDITIONAL UPDATE matching `status = pending`, so two concurrent confirms
     * cannot both succeed and the second is reported as a race rather than silently re-confirming a
     * factor that is already live.
     */
    async confirm(input: { userId: string; factorId: string; code: string; context?: MfaActorContext }): Promise<TotpVerifyResult> {
        const factor = await this.repo().findOne({
            where: { id: input.factorId, userId: input.userId, status: MfaFactorStatus.PENDING },
            select: TotpService.VERIFY_SELECT
        })
        if (!factor) {
            await this.auditChallenge(MfaAuditAction.ENROL_CONFIRM, AuditOutcome.FAILURE, input.context, input.userId, {
                factorId: input.factorId,
                reason: 'no_pending_factor'
            })
            return { ok: false, reason: 'no_confirmed_factor' }
        }

        const verification = this.verifyAgainstFactor(factor)(input.code)
        if (!verification.valid) {
            await this.auditChallenge(MfaAuditAction.ENROL_CONFIRM, AuditOutcome.FAILURE, input.context, input.userId, {
                factorId: factor.id,
                reason: verification.reason
            })
            return { ok: false, reason: verification.reason }
        }

        const committed = await this.commitStep(factor, verification.step, {
            status: MfaFactorStatus.CONFIRMED,
            confirmedDate: new Date(this.now())
        })
        if (!committed) {
            await this.auditChallenge(MfaAuditAction.ENROL_CONFIRM, AuditOutcome.FAILURE, input.context, input.userId, {
                factorId: factor.id,
                reason: 'race_lost'
            })
            return { ok: false, reason: 'race_lost' }
        }

        await this.auditChallenge(MfaAuditAction.ENROL_CONFIRM, AuditOutcome.SUCCESS, input.context, input.userId, { factorId: factor.id })
        return { ok: true, factorId: factor.id, step: verification.step }
    }

    /**
     * Verify a code against every CONFIRMED factor the user holds (requirements §8).
     *
     * ── Replay prevention, and why it needs no new column ────────────────────────────────────
     * A TOTP code stays valid for the whole of its step, so "correct code" and "code that has not
     * been used" are different questions. The guard is a per-factor watermark: the step of the last
     * accepted code. A match at or below it is {@link TotpRejection.REPLAYED}.
     *
     * The watermark is `MfaFactor.lastUsedDate`, written as the START INSTANT OF THE ACCEPTED STEP
     * rather than the wall-clock moment of verification. That single decision is what lets an
     * existing column carry the guard: `floor(lastUsedDate / 1000 / period)` recovers the step
     * exactly, and the entity's stated purpose for the column — "refreshed on each successful
     * challenge … rejecting a replayed code" — is met without a schema change. The cost is that the
     * account screen may render a timestamp up to one step (30 s) earlier than the challenge; the
     * entity already calls this "the coarse timestamp … the account screen renders".
     *
     * The commit is a compare-and-set on the previous `lastUsedDate` (see {@link commitStep}), so
     * two requests presenting the same code at the same instant cannot both win. Checking the
     * watermark and then writing it non-atomically would leave exactly the race the guard exists to
     * close.
     *
     * Every candidate factor is evaluated with no early exit, for the same reason the window is:
     * stopping at the first match would leak which authenticator the user presented.
     */
    async verify(input: { userId: string; code: string; context?: MfaActorContext }): Promise<TotpVerifyResult> {
        const factors = await this.repo().find({
            where: { userId: input.userId, status: MfaFactorStatus.CONFIRMED },
            select: TotpService.VERIFY_SELECT
        })

        if (factors.length === 0) {
            await this.auditChallenge(MfaAuditAction.CHALLENGE, AuditOutcome.FAILURE, input.context, input.userId, {
                reason: 'no_confirmed_factor'
            })
            return { ok: false, reason: 'no_confirmed_factor' }
        }

        let match: { factor: MfaFactor; step: number } | null = null
        let rejection: TotpRejection = TotpRejection.MISMATCH
        for (const factor of factors) {
            const verification = this.verifyAgainstFactor(factor)(input.code)
            if (verification.valid) {
                if (!match) match = { factor, step: verification.step }
            } else if (verification.reason === TotpRejection.REPLAYED) {
                // A replay is a materially more interesting outcome than a wrong code and must not
                // be masked by another factor reporting a plain mismatch.
                rejection = TotpRejection.REPLAYED
            } else if (rejection !== TotpRejection.REPLAYED) {
                rejection = verification.reason
            }
        }

        if (!match) {
            await this.auditChallenge(MfaAuditAction.CHALLENGE, AuditOutcome.FAILURE, input.context, input.userId, { reason: rejection })
            return { ok: false, reason: rejection }
        }

        const committed = await this.commitStep(match.factor, match.step, {})
        if (!committed) {
            // Lost the compare-and-set: another request spent this step first. That IS a replay,
            // detected at the write rather than at the read, and it is reported as one.
            await this.auditChallenge(MfaAuditAction.CHALLENGE, AuditOutcome.FAILURE, input.context, input.userId, {
                factorId: match.factor.id,
                reason: TotpRejection.REPLAYED
            })
            return { ok: false, reason: TotpRejection.REPLAYED }
        }

        await this.auditChallenge(MfaAuditAction.CHALLENGE, AuditOutcome.SUCCESS, input.context, input.userId, {
            factorId: match.factor.id
        })
        return { ok: true, factorId: match.factor.id, step: match.step }
    }

    /**
     * Remove factors (§8 requires re-authentication before this is reached — enforced at the route,
     * because only the HTTP layer holds the presented password).
     *
     * `MfaFactor.ts`: "A factor is either enrolled or gone; disabling MFA deletes the row … and the
     * AuditEvent trail is what preserves the fact that it existed." Recovery codes are NOT deleted
     * here: they belong to `RecoveryCodeService`, they are already hashed and single-use, and
     * destroying them as a side effect of removing one of several authenticators would be a
     * surprise. The route composes the two when the LAST factor goes.
     */
    async disable(input: { userId: string; factorId?: string | null; context?: MfaActorContext }): Promise<number> {
        const criteria = input.factorId ? { userId: input.userId, id: input.factorId } : { userId: input.userId }
        const removed = await this.repo().delete(criteria)
        const count = removed.affected ?? 0

        await this.audit.record({
            action: MfaAuditAction.DISABLE,
            outcome: count > 0 ? AuditOutcome.SUCCESS : AuditOutcome.FAILURE,
            subject: this.subject(input.context, input.userId),
            target: { type: 'mfa_factor', id: input.factorId ?? input.userId },
            scope: { organizationId: input.context?.organizationId ?? null, workspaceId: input.context?.workspaceId ?? null },
            route: input.context?.route ?? null,
            ipAddress: input.context?.ipAddress ?? null,
            userAgent: input.context?.userAgent ?? null,
            reason: count > 0 ? null : 'no_matching_factor',
            detail: { removed: count, factorId: input.factorId ?? null },
            message: `Removed ${count} MFA factor(s) for user ${input.userId}`
        })
        return count
    }

    /** Factors for the account screen. Never selects the seed or its metadata — see VERIFY_SELECT for the contrast. */
    async list(userId: string): Promise<TotpFactorSummary[]> {
        const factors = await this.repo().find({
            where: { userId },
            select: {
                id: true,
                userId: true,
                type: true,
                label: true,
                status: true,
                createdDate: true,
                confirmedDate: true,
                lastUsedDate: true
            },
            order: { createdDate: 'ASC' }
        })
        return factors.map((factor) => ({
            id: factor.id,
            type: factor.type,
            label: factor.label ?? null,
            status: factor.status,
            createdDate: factor.createdDate,
            confirmedDate: factor.confirmedDate ?? null,
            lastUsedDate: factor.lastUsedDate ?? null
        }))
    }

    /** The replay watermark carried by `lastUsedDate` — see {@link verify}. */
    private lastAcceptedStep(factor: MfaFactor): number | null {
        if (!factor.lastUsedDate) return null
        const at = new Date(factor.lastUsedDate).getTime()
        return Number.isNaN(at) ? null : timeStepAt(at)
    }

    /** Curried so the decrypted seed is scoped to one comparison and not held across the loop. */
    private verifyAgainstFactor(factor: MfaFactor): (code: string) => TotpVerification {
        return (code: string) => {
            let secret: Buffer
            try {
                secret = this.decryptSecret(factor)
            } catch (error) {
                // A seed that cannot be decrypted is a key-configuration problem, never a wrong
                // code. Fail closed and say so on the operator's log — reporting it as a mismatch
                // would send the user to re-enrol a perfectly good authenticator.
                logger.error(`[TotpService] factor ${factor.id} could not be decrypted: ${getMessage(error)}`)
                return { valid: false, reason: TotpRejection.MISMATCH, step: null }
            }
            try {
                return verifyCode(secret, code, { nowMs: this.now(), lastAcceptedStep: this.lastAcceptedStep(factor) })
            } finally {
                secret.fill(0)
            }
        }
    }

    /**
     * Advance the replay watermark, atomically.
     *
     * Compare-and-set on the previous `lastUsedDate` — the same technique `SessionService.refresh`
     * uses on the refresh digest, and for the same reason: the guard is only worth having if the
     * check and the write cannot be interleaved. `IsNull()` is used explicitly for the first
     * acceptance, because a literal `null` in an update criteria is not portably `IS NULL`.
     */
    private async commitStep(factor: MfaFactor, step: number, extra: Partial<MfaFactor>): Promise<boolean> {
        const criteria: Record<string, unknown> = {
            id: factor.id,
            lastUsedDate: factor.lastUsedDate ? new Date(factor.lastUsedDate) : IsNull()
        }
        if (extra.status) criteria.status = MfaFactorStatus.PENDING
        const result = await this.repo().update(criteria, { ...extra, lastUsedDate: new Date(step * TOTP_PERIOD_SECONDS * 1000) })
        return Boolean(result.affected)
    }

    private subject(context: MfaActorContext | undefined, userId: string) {
        return {
            type: AuditSubjectType.USER,
            id: userId,
            label: context?.email ?? null,
            sessionId: context?.sessionId ?? null
        }
    }

    private async auditChallenge(
        action: string,
        outcome: AuditOutcome,
        context: MfaActorContext | undefined,
        userId: string,
        detail: Record<string, unknown>
    ): Promise<void> {
        await this.audit.record({
            action,
            outcome,
            subject: this.subject(context, userId),
            target: { type: 'mfa_factor', id: (detail.factorId as string) ?? userId },
            scope: { organizationId: context?.organizationId ?? null, workspaceId: context?.workspaceId ?? null },
            route: context?.route ?? null,
            ipAddress: context?.ipAddress ?? null,
            userAgent: context?.userAgent ?? null,
            reason: (detail.reason as string) ?? null,
            detail: { ...detail, factorType: MfaFactorType.TOTP },
            message: `TOTP ${action} ${outcome} for user ${userId}`
        })
    }
}

const getMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))
