import { randomBytes } from 'node:crypto'
import { DataSource, IsNull, Repository } from 'typeorm'
import { v4 as uuidv4 } from 'uuid'
import { AuditOutcome, AuditSubjectType } from '../../database/entities/identity/AuditEvent'
import { MfaRecoveryCode } from '../../database/entities/identity/MfaRecoveryCode'
import { hash, verify, verifyDummy } from '../crypto/passwords'
import { AuditService } from './AuditService'
import { MfaActorContext, MfaAuditAction } from './MfaPolicyService'

/**
 * Identity — RecoveryCodeService (requirements §8, §9).
 *
 * §8: "Recovery codes are shown once, stored hashed, and individually consumable." This is the
 * escape hatch for a lost authenticator, and it is the only part of the MFA feature where the
 * server holds something a user could be socially engineered out of — so every property below is
 * chosen to make a stolen database, a shoulder-surfed screen or a replayed request worth as little
 * as possible.
 *
 * ── Hashed, NEVER encrypted ──────────────────────────────────────────────────────────────────
 * §9 is explicit: "hashes are not encryption. Passwords and recovery codes are hashed (argon2id or
 * bcrypt), never encrypted; they are never decryptable, by us or anyone." So these go through
 * `crypto/passwords.ts` and `MfaRecoveryCode` carries NONE of the EncryptionMetadata columns that
 * `MfaFactor.secret` does. The distinction is not bookkeeping: a TOTP seed must be recovered to
 * recompute an HMAC, a recovery code only ever has to be COMPARED — so encrypting it would add a
 * decryption path with no legitimate caller and one obvious illegitimate one.
 *
 * ── Why the codes look the way they do ───────────────────────────────────────────────────────
 * `passwords.hash` enforces the server-side password policy unconditionally, and deliberately
 * offers no bypass — `crypto/passwords.ts` records why: "there is no 'skip the policy' option,
 * because REQUIREMENTS §2 requires startup to refuse default/blank credentials and an escape hatch
 * here would be the first thing a bootstrap script reached for."
 *
 * Generated codes therefore have to SATISFY that policy rather than route around it: at least one
 * lowercase letter, one uppercase letter, one digit and one non-alphanumeric character. Hence the
 * shape `xxxxxx-xxxxxx` over a mixed-case alphabet — the hyphen supplies the special character (and
 * makes the code readable), and the three letter/digit classes are guaranteed by rejection
 * sampling, which keeps the distribution uniform over the codes that qualify rather than skewing it
 * by patching characters into fixed positions.
 *
 * The honest cost: mixed case makes a code slightly more annoying to retype than the all-uppercase
 * form some products use. That is the price of not carving a hole in a policy that exists to keep
 * bootstrap scripts honest, and it is the right trade — the alternative weakens a control that
 * protects every password on the instance in order to make a once-in-a-lost-phone flow marginally
 * nicer.
 *
 * ── Batches, not deletions ───────────────────────────────────────────────────────────────────
 * §8 requires regeneration to invalidate the previous set. `MfaRecoveryCode.ts` explains why that
 * is modelled as a `batchId` rather than a DELETE: "modelling that as 'delete the old rows' loses
 * the evidence that a set existed and was superseded". Verification is scoped to the CURRENT batch;
 * spent and superseded rows stay put for the audit trail.
 */

/** §8 gives no number. Ten is the interoperable convention and, at ~69 bits each, ten is plenty. */
export const RECOVERY_CODE_COUNT = 10

/** Two groups of six. Long enough to be unguessable, short enough to read off a printed page. */
const GROUP_LENGTH = 6
const GROUP_COUNT = 2
const GROUP_SEPARATOR = '-'

/**
 * Unambiguous alphabet: no `0`/`O`/`o`, no `1`/`l`/`I`. These codes get printed, photographed and
 * retyped under stress, and a character pair that cannot be told apart on paper turns a valid code
 * into a support ticket.
 *
 * 55 symbols → log2(55) ≈ 5.78 bits per character → ~69 bits over twelve characters, which is far
 * beyond anything an online guessing attack reaches against a bcrypt verifier.
 */
const LOWERCASE = 'abcdefghjkmnpqrstuvwxyz'
const UPPERCASE = 'ABCDEFGHJKMNPQRSTUVWXYZ'
const DIGITS = '23456789'
const ALPHABET = `${LOWERCASE}${UPPERCASE}${DIGITS}`

/**
 * Uniform random index over `size`, by rejection sampling.
 *
 * `randomBytes(1) % size` would be biased whenever 256 is not a multiple of `size` — for a 55-symbol
 * alphabet the first 36 symbols would be ~1.4× likelier than the rest. Discarding the tail of the
 * byte range removes the bias entirely at the cost of an occasional extra byte.
 */
const uniformIndex = (size: number): number => {
    const limit = Math.floor(256 / size) * size
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const byte = randomBytes(1)[0]
        if (byte < limit) return byte % size
    }
}

const hasEveryClass = (value: string): boolean => /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value)

/**
 * One recovery code, uniformly distributed over the codes that satisfy the password policy.
 *
 * Rejection sampling rather than "generate, then force a digit into position 4": forcing characters
 * into fixed positions makes those positions predictable and removes them from the search space.
 * Roughly one code in five is rejected, which costs a few extra bytes of entropy and nothing else.
 */
const generateCode = (): string => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const groups: string[] = []
        for (let group = 0; group < GROUP_COUNT; group++) {
            let characters = ''
            for (let index = 0; index < GROUP_LENGTH; index++) characters += ALPHABET[uniformIndex(ALPHABET.length)]
            groups.push(characters)
        }
        const code = groups.join(GROUP_SEPARATOR)
        if (hasEveryClass(code)) return code
    }
}

/**
 * Presentation is normalised, CONTENT is not.
 *
 * Surrounding whitespace is stripped because it is a copy-paste artefact. Case is NOT folded and
 * internal characters are NOT rewritten: the codes are mixed-case by construction, so lower-casing
 * a presented code would make it fail against its own hash, and "helpfully" repairing a separator
 * would mean accepting a code the user never held.
 */
const normalise = (code: unknown): string => (typeof code === 'string' ? code.trim() : '')

/** Returned by {@link RecoveryCodeService.generate}. `codes` is plaintext and exists exactly once (§8). */
export interface RecoveryCodeBatch {
    batchId: string
    /** Shown to the user once. Never persisted, never logged, never recoverable. */
    codes: string[]
    generatedDate: Date
}

export interface RecoveryCodeStatus {
    /** False when the user has never generated a batch. */
    enrolled: boolean
    batchId: string | null
    total: number
    remaining: number
    generatedDate: Date | null
}

export type RecoveryConsumption =
    | { ok: true; codeId: string; batchId: string; remaining: number }
    | { ok: false; reason: 'no_codes' | 'mismatch' | 'race_lost'; remaining: number }

export interface RecoveryCodeServiceOptions {
    /** Omit in the running server; it resolves `AppDataSource` lazily, exactly like the other services do. */
    dataSource?: DataSource
    audit?: AuditService
    /** Codes per batch. Lowering it below the default weakens the escape hatch; raising it is free. */
    count?: number
}

export class RecoveryCodeService {
    private readonly injectedDataSource?: DataSource
    private readonly audit: AuditService
    private readonly count: number

    constructor(options: RecoveryCodeServiceOptions = {}) {
        this.injectedDataSource = options.dataSource
        this.audit = options.audit ?? new AuditService({ dataSource: options.dataSource })
        this.count = options.count ?? RECOVERY_CODE_COUNT
    }

    /** Lazy `require` for the same reason SessionService uses one: a static import would drag in the server entrypoint. */
    private getDataSource(): DataSource {
        if (this.injectedDataSource) return this.injectedDataSource
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { getRunningExpressApp } = require('../../utils/getRunningExpressApp')
        return getRunningExpressApp().AppDataSource
    }

    private repo(): Repository<MfaRecoveryCode> {
        return this.getDataSource().getRepository(MfaRecoveryCode)
    }

    /**
     * The batch currently accepted for verification: the most recently created one.
     *
     * Derived rather than flagged, because a `isCurrent` column would be a second source of truth
     * that a crashed regeneration could leave pointing at two batches — or at none. "Newest wins"
     * cannot be inconsistent with itself. Batches are created one per request, so the millisecond
     * collision that would make the ordering ambiguous is not reachable in practice.
     */
    async currentBatchId(userId: string): Promise<string | null> {
        const newest = await this.repo().find({
            where: { userId },
            select: { id: true, userId: true, batchId: true, createdDate: true },
            order: { createdDate: 'DESC' },
            take: 1
        })
        return newest[0]?.batchId ?? null
    }

    /**
     * Issue a fresh batch and return the plaintext ONCE (§8).
     *
     * Every prior batch stops being accepted the moment this returns, because verification is scoped
     * to {@link currentBatchId} — that is §8's "regeneration invalidates the previous set", achieved
     * without destroying the evidence that the previous set existed.
     *
     * The hashes are produced concurrently. Each is a deliberately slow bcrypt at the configured
     * cost, and doing ten in series would put a couple of seconds of latency on a request that has
     * no reason to carry it.
     */
    async generate(input: { userId: string; context?: MfaActorContext }): Promise<RecoveryCodeBatch> {
        const batchId = uuidv4()
        const codes = Array.from({ length: this.count }, () => generateCode())
        const hashes = await Promise.all(codes.map((code) => hash(code)))
        const generatedDate = new Date()

        const rows = hashes.map((codeHash) =>
            this.repo().create({ userId: input.userId, batchId, codeHash, consumedDate: null, consumedBySessionId: null })
        )
        await this.repo().save(rows)

        await this.audit.record({
            action: MfaAuditAction.RECOVERY_GENERATE,
            outcome: AuditOutcome.SUCCESS,
            subject: this.subject(input.context, input.userId),
            target: { type: 'mfa_recovery_batch', id: batchId },
            scope: { organizationId: input.context?.organizationId ?? null, workspaceId: input.context?.workspaceId ?? null },
            route: input.context?.route ?? null,
            ipAddress: input.context?.ipAddress ?? null,
            userAgent: input.context?.userAgent ?? null,
            // The count and the batch id, never a code. §10: "recorded by reference, never by value."
            detail: { batchId, count: codes.length },
            message: `Issued ${codes.length} MFA recovery codes for user ${input.userId}; all earlier batches invalidated`
        })

        return { batchId, codes, generatedDate }
    }

    /**
     * Redeem one code. Single-use, current-batch-only (§8: "individually consumable").
     *
     * ── Constant work, regardless of state ───────────────────────────────────────────────────
     * The digests are individually salted, so there is nothing to look up by — `MfaRecoveryCode.ts`
     * says so directly: "argon2id/bcrypt digests are individually salted … verification loads the
     * user's unconsumed codes for the current batch … and compares each in constant time."
     *
     * This method performs EXACTLY `count` verifications on every call, and never breaks early:
     *   - no early exit, so the response time does not reveal WHICH code matched;
     *   - unconsumed rows are padded with `verifyDummy()` to a fixed total, so the response time
     *     does not reveal HOW MANY codes are left — which would otherwise let an attacker watch a
     *     victim's remaining budget shrink, and know when a compromised code was spent;
     *   - a user with no batch at all runs the same fixed work, so "this account has recovery codes"
     *     is not an observable fact.
     *
     * The bill is `count` bcrypt comparisons — a couple of seconds at the configured cost. That is
     * accepted rather than tolerated: redeeming a recovery code is a once-per-lost-phone event, and
     * the same slowness is what makes online guessing against a ~69-bit code hopeless.
     *
     * ── Single use is enforced at the WRITE ──────────────────────────────────────────────────
     * The consumption is a conditional UPDATE matching `consumedDate IS NULL`. Two requests
     * presenting the same code concurrently both find it unconsumed; only one wins the update, and
     * the loser is reported as a failure rather than admitted on a stale read.
     */
    async consume(input: {
        userId: string
        code: string
        sessionId?: string | null
        context?: MfaActorContext
    }): Promise<RecoveryConsumption> {
        const presented = normalise(input.code)
        const batchId = await this.currentBatchId(input.userId)

        const candidates = batchId
            ? await this.repo().find({
                  where: { userId: input.userId, batchId, consumedDate: IsNull() },
                  select: { id: true, userId: true, batchId: true, codeHash: true, consumedDate: true },
                  order: { createdDate: 'ASC' }
              })
            : []

        let matched: MfaRecoveryCode | null = null
        for (let index = 0; index < Math.max(this.count, candidates.length); index++) {
            const candidate = candidates[index]
            if (!candidate) {
                // Padding, so the elapsed time is a function of `count` and not of how many codes
                // this account has left. Its result is discarded by construction — verifyDummy()
                // always resolves false.
                await verifyDummy()
                continue
            }
            const isMatch = presented.length > 0 && (await verify(presented, candidate.codeHash))
            // No `break`: see the doc comment.
            if (isMatch && !matched) matched = candidate
        }

        if (!matched) {
            await this.auditConsumption(AuditOutcome.FAILURE, input, batchId, null, candidates.length, batchId ? 'mismatch' : 'no_codes')
            return { ok: false, reason: batchId ? 'mismatch' : 'no_codes', remaining: candidates.length }
        }

        const result = await this.repo().update(
            { id: matched.id, consumedDate: IsNull() },
            { consumedDate: new Date(), consumedBySessionId: input.sessionId ?? null }
        )
        if (!result.affected) {
            await this.auditConsumption(AuditOutcome.FAILURE, input, batchId, matched.id, candidates.length, 'race_lost')
            return { ok: false, reason: 'race_lost', remaining: candidates.length - 1 }
        }

        const remaining = candidates.length - 1
        await this.auditConsumption(AuditOutcome.SUCCESS, input, batchId, matched.id, remaining, null)
        return { ok: true, codeId: matched.id, batchId: matched.batchId, remaining }
    }

    /**
     * How many codes are left, for the account screen. Counts the CURRENT batch only — superseded
     * rows are history, not budget.
     */
    async status(userId: string): Promise<RecoveryCodeStatus> {
        const batchId = await this.currentBatchId(userId)
        if (!batchId) return { enrolled: false, batchId: null, total: 0, remaining: 0, generatedDate: null }

        const rows = await this.repo().find({
            where: { userId, batchId },
            select: { id: true, userId: true, batchId: true, consumedDate: true, createdDate: true }
        })
        return {
            enrolled: true,
            batchId,
            total: rows.length,
            remaining: rows.filter((row) => !row.consumedDate).length,
            generatedDate: rows[0]?.createdDate ?? null
        }
    }

    private subject(context: MfaActorContext | undefined, userId: string) {
        return { type: AuditSubjectType.USER, id: userId, label: context?.email ?? null, sessionId: context?.sessionId ?? null }
    }

    private async auditConsumption(
        outcome: AuditOutcome,
        input: { userId: string; sessionId?: string | null; context?: MfaActorContext },
        batchId: string | null,
        codeId: string | null,
        remaining: number,
        reason: string | null
    ): Promise<void> {
        await this.audit.record({
            action: MfaAuditAction.RECOVERY_CONSUME,
            outcome,
            subject: this.subject(input.context, input.userId),
            // The row id, so a suspicious redemption is traceable — never the code, which is why
            // there is no parameter here that could carry one (§10).
            target: { type: 'mfa_recovery_code', id: codeId ?? batchId ?? input.userId },
            scope: { organizationId: input.context?.organizationId ?? null, workspaceId: input.context?.workspaceId ?? null },
            route: input.context?.route ?? null,
            ipAddress: input.context?.ipAddress ?? null,
            userAgent: input.context?.userAgent ?? null,
            reason,
            detail: { batchId, codeId, remaining, consumedBySessionId: input.sessionId ?? null },
            message: `MFA recovery code redemption ${outcome} for user ${input.userId}`
        })
    }
}
