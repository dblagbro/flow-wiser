import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { DataSource, IsNull, Repository } from 'typeorm'
import { KeyedDigestAlgorithm } from '../../database/entities/identity/EncryptionMetadata'
import { Session, SessionAuthMethod, SessionRevokeReason } from '../../database/entities/identity/Session'
import { User } from '../../database/entities/identity/User'
import logger from '../../utils/logger'

/**
 * Identity — SessionService (requirements §5 "Sessions that can be revoked", §9 "Encryption at rest").
 *
 * The session is a SERVER-SIDE RECORD (see Session.ts). The client holds only the row id plus a
 * refresh secret, so revocation is one UPDATE and takes effect on the next request — the property a
 * stateless JWT cannot offer.
 *
 * Two invariants drive everything below:
 *
 *  1. The refresh secret NEVER exists in the database. Only an HMAC-SHA-256 keyed digest of it does
 *     (§9: session refresh secrets are among the values protected at rest). The plaintext is
 *     returned to the caller exactly once, at issue and at each refresh, and is unrecoverable
 *     afterwards.
 *  2. Validation FAILS CLOSED. Every path that cannot positively prove a session is live returns
 *     invalid — including unexpected exceptions, an unreadable pepper, and a key version whose
 *     pepper has been retired.
 */

/** Why a session did not validate. Stable, snake_case, safe to switch on and to feed to the audit trail. */
export enum SessionInvalidReason {
    NOT_FOUND = 'not_found',
    REVOKED = 'revoked',
    EXPIRED = 'expired',
    /** The presented secret did not match the stored digest — a wrong, stale or forged cookie. */
    SECRET_MISMATCH = 'secret_mismatch',
    /** `User.credentialUpdatedDate` is newer than the session's `issuedDate` (spec §D.12). */
    CREDENTIAL_CHANGED = 'credential_changed',
    /** The pepper generation this session was issued under is no longer configured — see the note on rotation. */
    UNKNOWN_KEY_VERSION = 'unknown_key_version',
    /** The owning user row disappeared underneath a live session. */
    USER_NOT_FOUND = 'user_not_found',
    /** Anything threw. Denied rather than passed through — fail closed. */
    INTERNAL_ERROR = 'internal_error'
}

export type SessionValidation = { valid: true; session: Session } | { valid: false; reason: SessionInvalidReason }

/** What `issue()` and `refresh()` hand back. `refreshSecret` is plaintext and must never be logged or persisted. */
export interface IssuedSession {
    sessionId: string
    /** Returned once. The only copy after this call lives in the client's cookie. */
    refreshSecret: string
    expiresDate: Date
}

export interface IssueSessionInput {
    userId: string
    activeWorkspaceId?: string | null
    authMethod?: SessionAuthMethod
    loginMethodId?: string | null
    /** Provider name denormalised at issue time so the trail survives reconfiguration (see Session.ts). */
    authProvider?: string | null
    mfaSatisfied?: boolean
    mfaFactorId?: string | null
    mfaSatisfiedDate?: Date | null
    userAgent?: string | null
    ip?: string | null
    /** Overrides the configured refresh window for this session only. */
    ttlMs?: number
}

/**
 * A pepper generation. `secret` is the HMAC key; it is server-held and never leaves the process.
 *
 * §9 requires "a key version recorded per record so rotation is resumable and auditable", and
 * Session.ts explains why a keyed digest rotates GENERATIONALLY rather than in place: recomputing
 * the HMAC under a new pepper would require the refresh secret, which only the client has. So old
 * generations must remain resolvable for verification until the longest live `expiresDate` passes.
 */
export interface SessionPepper {
    keyId: string
    version: number
    secret: Buffer
}

/**
 * Where peppers come from. Injectable so that `identity/crypto/keyring.ts` can become the
 * implementation without touching a call site — the default below is deliberately minimal and is
 * the integration seam, not the intended long-term source of key material.
 */
export interface SessionPepperProvider {
    /** The generation new sessions are issued under. Throws if none is configured — see EnvSessionPepperProvider. */
    current(): SessionPepper
    /** Resolve the generation a stored row was written under, or undefined when it has been retired. */
    forVersion(version: number | null | undefined): SessionPepper | undefined
}

const DEFAULT_REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** 256 bits, per §9's treatment of the secret as its own salt (Session.ts: "no nonce or salt column"). */
const REFRESH_SECRET_BYTES = 32

/**
 * Env-backed pepper source — the stop-gap until `crypto/keyring.ts` lands.
 *
 * `FLOWISE_SESSION_PEPPER`      current pepper (base64 or utf-8), required
 * `FLOWISE_SESSION_PEPPER_ID`   key id recorded on the row (default `session-pepper`)
 * `FLOWISE_SESSION_PEPPER_V<n>` retired generations, kept only for verification
 *
 * §9 wants key material injectable from outside the host (env, 0400 key file, KMS/Vault); reading
 * env is the first of those and the one that composes with the other two.
 *
 * There is NO generated fallback. A silently invented pepper would either be stable and weak, or
 * ephemeral and would log every user out on restart without saying why. Refusing to issue is the
 * fail-closed behaviour, and it is loud.
 */
export class EnvSessionPepperProvider implements SessionPepperProvider {
    private read(version: number): Buffer | undefined {
        const raw =
            version === this.currentVersion() ? process.env.FLOWISE_SESSION_PEPPER : process.env[`FLOWISE_SESSION_PEPPER_V${version}`]
        if (!raw) return undefined
        return Buffer.from(raw, 'utf-8')
    }

    private currentVersion(): number {
        const parsed = Number.parseInt(process.env.FLOWISE_SESSION_PEPPER_VERSION ?? '1', 10)
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
    }

    current(): SessionPepper {
        const version = this.currentVersion()
        const secret = this.read(version)
        if (!secret || secret.length === 0) {
            throw new Error(
                'FLOWISE_SESSION_PEPPER is not set. Sessions cannot be issued without it (requirements §9) — provide it from the environment, a 0400 key file, or a KMS/Vault reference.'
            )
        }
        return { keyId: process.env.FLOWISE_SESSION_PEPPER_ID ?? 'session-pepper', version, secret }
    }

    forVersion(version: number | null | undefined): SessionPepper | undefined {
        const resolved = version ?? this.currentVersion()
        const secret = this.read(resolved)
        if (!secret || secret.length === 0) return undefined
        return { keyId: process.env.FLOWISE_SESSION_PEPPER_ID ?? 'session-pepper', version: resolved, secret }
    }
}

export interface SessionServiceOptions {
    /** Omit in the running server; it resolves `AppDataSource` lazily, exactly like the other services do. */
    dataSource?: DataSource
    pepperProvider?: SessionPepperProvider
    /** Refresh window. Also read from `FLOWISE_SESSION_TTL_MS` when omitted. */
    refreshTtlMs?: number
}

export class SessionService {
    private readonly injectedDataSource?: DataSource
    private readonly peppers: SessionPepperProvider
    private readonly refreshTtlMs: number

    constructor(options: SessionServiceOptions = {}) {
        this.injectedDataSource = options.dataSource
        this.peppers = options.pepperProvider ?? new EnvSessionPepperProvider()
        const fromEnv = Number.parseInt(process.env.FLOWISE_SESSION_TTL_MS ?? '', 10)
        this.refreshTtlMs = options.refreshTtlMs ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_REFRESH_TTL_MS)
    }

    /**
     * Same DataSource the rest of `services/` uses (`getRunningExpressApp().AppDataSource`), but
     * resolved through a lazy `require` rather than a top-level import: importing
     * `getRunningExpressApp` statically pulls in the server entrypoint, which would make this
     * service impossible to construct — or to test — without booting the whole application.
     */
    private getDataSource(): DataSource {
        if (this.injectedDataSource) return this.injectedDataSource
        const { getRunningExpressApp } = require('../../utils/getRunningExpressApp')
        return getRunningExpressApp().AppDataSource
    }

    private repo(): Repository<Session> {
        return this.getDataSource().getRepository(Session)
    }

    /** HMAC-SHA-256 of the secret under a pepper generation. Hex — 64 chars, inside the column's 128. */
    private digest(secret: string, pepper: SessionPepper): string {
        return createHmac('sha256', pepper.secret).update(secret, 'utf-8').digest('hex')
    }

    /**
     * Constant-time comparison of two hex digests.
     *
     * `timingSafeEqual` throws on a length mismatch, which would itself leak length through the
     * exception path, so unequal lengths are answered false directly. Both inputs are fixed-width
     * hex digests, so this only fires on a malformed stored value.
     */
    private digestsMatch(a: string, b: string): boolean {
        const left = Buffer.from(a, 'utf-8')
        const right = Buffer.from(b, 'utf-8')
        if (left.length !== right.length) return false
        return timingSafeEqual(left, right)
    }

    /**
     * Create a session row and return the id plus the plaintext refresh secret.
     *
     * The secret is 256 bits of CSPRNG output, base64url-encoded. It is hashed before the row is
     * written; nothing in this method ever puts the plaintext anywhere but the return value.
     */
    async issue(input: IssueSessionInput): Promise<IssuedSession> {
        const pepper = this.peppers.current()
        const refreshSecret = randomBytes(REFRESH_SECRET_BYTES).toString('base64url')
        const now = new Date()
        const expiresDate = new Date(now.getTime() + (input.ttlMs ?? this.refreshTtlMs))

        const session = this.repo().create({
            userId: input.userId,
            activeWorkspaceId: input.activeWorkspaceId ?? null,
            refreshTokenHash: this.digest(refreshSecret, pepper),
            refreshTokenKeyId: pepper.keyId,
            refreshTokenKeyVersion: pepper.version,
            refreshTokenAlgorithm: KeyedDigestAlgorithm.HMAC_SHA256,
            authMethod: input.authMethod ?? SessionAuthMethod.LOCAL,
            loginMethodId: input.loginMethodId ?? null,
            authProvider: input.authProvider ?? null,
            // §8: MFA is evaluated BEFORE the session exists, so this records what "complete" meant
            // for this session rather than a step still outstanding.
            mfaSatisfied: input.mfaSatisfied ?? false,
            mfaFactorId: input.mfaFactorId ?? null,
            mfaSatisfiedDate: input.mfaSatisfiedDate ?? null,
            issuedDate: now,
            expiresDate,
            revokedDate: null,
            userAgent: input.userAgent ?? null,
            ipAddress: input.ip ?? null,
            lastActiveDate: now
        })

        const saved = await this.repo().save(session)
        return { sessionId: saved.id, refreshSecret, expiresDate: saved.expiresDate }
    }

    /**
     * Prove a session is live (requirements §5).
     *
     * Checks, in order: the row exists → not revoked → not expired → the presented secret matches
     * the stored digest → the owner's credential has not changed since issue.
     *
     * The last check is what makes "a password change invalidates every outstanding session" true
     * WITHOUT writing to the session rows (Session.ts, spec §D.12): `credentialUpdatedDate` is
     * bumped once on the user, and every session issued before that instant stops validating. The
     * same column carries "rotation on privilege change" (§5).
     *
     * FAILS CLOSED: the whole body is wrapped, and any throw becomes `INTERNAL_ERROR`/invalid.
     */
    async validate(sessionId: string, refreshSecret: string): Promise<SessionValidation> {
        try {
            if (!sessionId || !refreshSecret) return { valid: false, reason: SessionInvalidReason.NOT_FOUND }

            const session = await this.repo().findOne({ where: { id: sessionId } })
            if (!session) return { valid: false, reason: SessionInvalidReason.NOT_FOUND }
            if (session.revokedDate) return { valid: false, reason: SessionInvalidReason.REVOKED }

            const now = new Date()
            if (!session.expiresDate || session.expiresDate.getTime() <= now.getTime()) {
                return { valid: false, reason: SessionInvalidReason.EXPIRED }
            }

            // Verify under the generation this row was written with, not the current one — peppers
            // rotate generationally (§9, and the rotation note in Session.ts).
            const pepper = this.peppers.forVersion(session.refreshTokenKeyVersion)
            if (!pepper) return { valid: false, reason: SessionInvalidReason.UNKNOWN_KEY_VERSION }
            if (!this.digestsMatch(this.digest(refreshSecret, pepper), session.refreshTokenHash)) {
                return { valid: false, reason: SessionInvalidReason.SECRET_MISMATCH }
            }

            const user = await this.getDataSource()
                .getRepository(User)
                .findOne({ where: { id: session.userId }, select: { id: true, credentialUpdatedDate: true } })
            if (!user) return { valid: false, reason: SessionInvalidReason.USER_NOT_FOUND }
            if (user.credentialUpdatedDate && user.credentialUpdatedDate.getTime() > session.issuedDate.getTime()) {
                return { valid: false, reason: SessionInvalidReason.CREDENTIAL_CHANGED }
            }

            return { valid: true, session }
        } catch (error) {
            // Fail closed: an unreadable pepper, a dead connection or a malformed row must deny, never admit.
            logger.error(`[SessionService] validate failed closed for session ${sessionId}: ${getMessage(error)}`)
            return { valid: false, reason: SessionInvalidReason.INTERNAL_ERROR }
        }
    }

    /**
     * Rotate the refresh secret and extend the window, keeping the SAME session id (spec §E.4: the
     * client treats a truthy `id` in the refresh response as "replay the original request").
     *
     * The rotation is a conditional UPDATE matching the OLD digest, which is what makes replay
     * detectable: a second refresh presenting an already-rotated secret matches zero rows and is
     * denied, rather than quietly minting a second live secret for one session.
     */
    async refresh(
        sessionId: string,
        refreshSecret: string
    ): Promise<{ ok: true; issued: IssuedSession } | { ok: false; reason: SessionInvalidReason }> {
        try {
            const validation = await this.validate(sessionId, refreshSecret)
            if (!validation.valid) return { ok: false, reason: validation.reason }

            const pepper = this.peppers.current()
            const previousHash = validation.session.refreshTokenHash
            const nextSecret = randomBytes(REFRESH_SECRET_BYTES).toString('base64url')
            const now = new Date()
            const expiresDate = new Date(now.getTime() + this.refreshTtlMs)

            const result = await this.repo().update(
                // The old digest in the WHERE clause is the replay guard; `revokedDate: IsNull()`
                // closes the race against a concurrent revoke.
                { id: sessionId, refreshTokenHash: previousHash, revokedDate: IsNull() },
                {
                    refreshTokenHash: this.digest(nextSecret, pepper),
                    refreshTokenKeyId: pepper.keyId,
                    // Rotation re-issues under the CURRENT generation, which is how a retired pepper
                    // drains from the live population without a re-key pass (§9).
                    refreshTokenKeyVersion: pepper.version,
                    refreshTokenAlgorithm: KeyedDigestAlgorithm.HMAC_SHA256,
                    expiresDate,
                    lastActiveDate: now
                }
            )

            if (!result.affected) return { ok: false, reason: SessionInvalidReason.SECRET_MISMATCH }
            return { ok: true, issued: { sessionId, refreshSecret: nextSecret, expiresDate } }
        } catch (error) {
            logger.error(`[SessionService] refresh failed closed for session ${sessionId}: ${getMessage(error)}`)
            return { ok: false, reason: SessionInvalidReason.INTERNAL_ERROR }
        }
    }

    /**
     * Revoke one session. Idempotent by construction: `revokedDate IS NULL` in the WHERE clause
     * means a second call reports false rather than overwriting the original reason and timestamp,
     * which the audit trail depends on staying put.
     */
    async revoke(sessionId: string, reason: SessionRevokeReason): Promise<boolean> {
        try {
            const result = await this.repo().update(
                { id: sessionId, revokedDate: IsNull() },
                { revokedDate: new Date(), revokedReason: reason }
            )
            return Boolean(result.affected)
        } catch (error) {
            logger.error(`[SessionService] revoke failed for session ${sessionId}: ${getMessage(error)}`)
            return false
        }
    }

    /**
     * Bulk revoke for one user — ONE statement, served by the (userId, revokedDate) index that
     * Session.ts documents:
     *
     *     UPDATE identity_session SET revokedDate = now(), revokedReason = ?
     *      WHERE userId = ? AND revokedDate IS NULL
     *
     * Used by "log out everywhere", by removal from an organization (tenancy §3.2: "every session
     * bound to that org is revoked immediately — not on next login"), and by privilege change (§5).
     *
     * Returns the number revoked so the caller can audit the count.
     */
    async revokeAllForUser(userId: string, reason: SessionRevokeReason): Promise<number> {
        try {
            const result = await this.repo().update({ userId, revokedDate: IsNull() }, { revokedDate: new Date(), revokedReason: reason })
            return result.affected ?? 0
        } catch (error) {
            logger.error(`[SessionService] revokeAllForUser failed for user ${userId}: ${getMessage(error)}`)
            return 0
        }
    }

    /**
     * Refresh `lastActiveDate` (drives idle timeout and the active-session list, §5).
     *
     * Deliberately cheap: a single targeted UPDATE with no preceding SELECT and no entity
     * hydration, because this runs on every authenticated request. It never throws — a failed
     * bookkeeping write must not fail the request that triggered it.
     */
    async touch(sessionId: string): Promise<void> {
        try {
            await this.repo().update({ id: sessionId, revokedDate: IsNull() }, { lastActiveDate: new Date() })
        } catch (error) {
            logger.warn(`[SessionService] touch failed for session ${sessionId}: ${getMessage(error)}`)
        }
    }

    /** Live sessions for the active-session list (§5). Ordered newest-first; never exposes the digest columns. */
    async listActiveForUser(userId: string): Promise<Session[]> {
        try {
            const now = new Date()
            const sessions = await this.repo().find({ where: { userId, revokedDate: IsNull() }, order: { issuedDate: 'DESC' } })
            return sessions.filter((session) => session.expiresDate.getTime() > now.getTime())
        } catch (error) {
            logger.error(`[SessionService] listActiveForUser failed for user ${userId}: ${getMessage(error)}`)
            return []
        }
    }
}

const getMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))
