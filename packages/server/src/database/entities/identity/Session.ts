/* eslint-disable */
import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index, ManyToOne, JoinColumn } from 'typeorm'
import { User } from './User'
import { KeyedDigestAlgorithm, ENCRYPTION_KEY_ID_MAX_LENGTH } from './EncryptionMetadata'

/**
 * How the primary authentication that produced this session was performed (requirements §7).
 *
 * The session has to record this rather than infer it from `User.isSSO`: §7 requires local accounts
 * and SSO to coexist ("SSO must never be the only way in, or a provider outage locks everyone out"),
 * so the same user can hold one session of each kind at the same time. Deriving the mode from the
 * user would mislabel both.
 */
export enum SessionAuthMethod {
    /** Email + password against `User.credential` */
    LOCAL = 'local',
    /** OAuth2/OIDC authorization-code flow with PKCE — `loginMethodId` names the provider */
    SSO = 'sso'
}

/** Why a session stopped being valid — kept for the audit trail and for the active-session list */
export enum SessionRevokeReason {
    LOGOUT = 'logout',
    /** Explicit revoke from the account screen, or bulk revoke of every session for a user */
    REVOKED = 'revoked',
    /** Credential change — spec §D.12 requires the session to die with the password */
    CREDENTIAL_CHANGED = 'credential_changed',
    /** Role/membership change — requirements §5 "rotation on privilege change" */
    PRIVILEGE_CHANGED = 'privilege_changed',
    /** Superseded by refresh-token rotation */
    ROTATED = 'rotated'
}

/**
 * Identity — Session (spec §D.12, requirements §5 "Sessions that can be revoked").
 *
 * Sessions are SERVER-SIDE RECORDS, not self-contained tokens: a cookie only carries this row's id
 * plus the refresh secret, so revocation is a single UPDATE and takes effect on the next request.
 * That is the improvement over a stateless JWT, which cannot be withdrawn before it expires.
 *
 * Revocation is checked as `revokedDate IS NULL AND expiresDate > now()`, plus the
 * `User.credentialUpdatedDate > issuedDate` guard, so a password change invalidates every
 * outstanding session without writing to them.
 *
 * Bulk revoke per user is a single statement:
 *     UPDATE identity_session SET revokedDate = now(), revokedReason = ?
 *      WHERE userId = ? AND revokedDate IS NULL
 * served by the index on (userId, revokedDate).
 */
@Entity('identity_session')
export class Session {
    /**
     * Also the `id` that `POST /auth/refreshToken` must return in its body — the client treats a
     * truthy `id` as "refresh succeeded, replay the original request" (spec §E.4).
     */
    @PrimaryGeneratedColumn('uuid')
    id: string

    @Index()
    @Column({ type: 'uuid' })
    userId: string

    /**
     * The session binds the active workspace (spec §D.12); permission resolution reads it from here,
     * never from the request. `POST /workspace/switch` re-mints the session against a new workspace.
     */
    @Column({ nullable: true, type: 'uuid' })
    activeWorkspaceId?: string | null

    /**
     * Keyed digest (HMAC-SHA-256 under a server-held pepper) of the refresh secret carried by the
     * refresh cookie. Hashed, never plaintext: a DB read must not yield a usable credential. Unique
     * so a stolen-and-replayed secret can be detected on rotation.
     *
     * Requirements §9 lists "session refresh secrets" among the values protected at rest. It is a
     * KEYED DIGEST rather than a ciphertext because verification only ever needs a comparison — see
     * `refreshTokenKeyVersion` for what that means for rotation.
     */
    @Index({ unique: true })
    @Column({ type: 'varchar', length: 128 })
    refreshTokenHash: string

    /** Which pepper produced `refreshTokenHash` — see EncryptionMetadata.ts */
    @Column({ nullable: true, type: 'varchar', length: ENCRYPTION_KEY_ID_MAX_LENGTH })
    refreshTokenKeyId?: string | null

    /**
     * Pepper version in force when this session was issued (requirements §9, per-record key
     * version).
     *
     * ── This one CANNOT be re-keyed in place, and that is not a gap ──────────────────────────
     * Re-encrypting a ciphertext is possible because the server can decrypt it first. A keyed
     * digest has no such inverse: recomputing the HMAC under a new pepper would require the refresh
     * secret, which exists only in the client's cookie. So rotation here is generational — new
     * sessions are issued under the new version, existing ones keep verifying under the old pepper
     * (retained for exactly as long as the longest live `expiresDate`), and the population drains
     * on its own. The indexed version column is what makes that observable: an operator can count
     * how many sessions still depend on a retired pepper, and revoke them outright if the rotation
     * was prompted by a compromise rather than by schedule.
     */
    @Index()
    @Column({ nullable: true, type: 'int' })
    refreshTokenKeyVersion?: number | null

    /** No nonce or salt column: the digest input is a fresh 256-bit random secret, so it is its own salt */
    @Column({ nullable: true, type: 'varchar', length: 32 })
    refreshTokenAlgorithm?: KeyedDigestAlgorithm | null

    /**
     * How primary authentication was performed. Defaulted to `local` so an existing row — and any
     * code path that has not been taught about SSO yet — describes itself accurately rather than
     * claiming an SSO login it never had (requirements §7).
     */
    @Column({ type: 'varchar', length: 16, default: SessionAuthMethod.LOCAL })
    authMethod: SessionAuthMethod

    /**
     * The LoginMethod that authenticated this session; null for `authMethod = local`
     * (requirements §7). Not an FK constraint, per house style.
     */
    @Column({ nullable: true, type: 'uuid' })
    loginMethodId?: string | null

    /**
     * Provider name (`google` | `azure` | `github` | `auth0`) denormalised from the LoginMethod at
     * issue time. Deliberate duplication: the audit trail and the active-session list must still be
     * able to say WHICH provider signed this session in after the provider's configuration row has
     * been deleted or repointed. `loginMethodId` answers "which config", this answers "which IdP",
     * and only the second survives reconfiguration.
     */
    @Column({ nullable: true, type: 'varchar', length: 20 })
    authProvider?: string | null

    /**
     * Whether the MFA policy in force was satisfied before this session was issued
     * (requirements §8).
     *
     * §8: "MFA is evaluated after primary auth (local or SSO) and BEFORE a session is issued, so a
     * session never exists in a half-authenticated state." That is why this is a property of the
     * session and not a step tracked on it: there is no `mfa_pending` state to represent. A session
     * row exists only once authentication is complete, and this column records what "complete"
     * meant for it — `true` when a factor or recovery code was verified, `false` when policy did
     * not require one.
     *
     * Recording the `false` case matters as much as the `true` one: tightening the policy from
     * optional to required needs to identify the live sessions that predate the change, and that is
     * `WHERE mfaSatisfied = false AND revokedDate IS NULL`.
     */
    @Column({ type: 'boolean', default: false })
    mfaSatisfied: boolean

    /**
     * Which factor satisfied the challenge (`identity_mfa_factor.id`), or null when it was a
     * recovery code or when no challenge was required. Lets a compromised authenticator be traced
     * to every session it admitted.
     */
    @Column({ nullable: true, type: 'uuid' })
    mfaFactorId?: string | null

    /**
     * When the challenge was passed. Always at or before `issuedDate` by construction (§8), and
     * kept separately so a future step-up/re-authentication requirement — §8 needs one to disable
     * MFA or regenerate recovery codes — can measure the age of the proof.
     */
    @Column({ type: 'timestamp', nullable: true })
    mfaSatisfiedDate?: Date | null

    /** Access-credential lifetime is short and independent; this is the refresh window (spec §E.4) */
    @Column({ type: 'timestamp' })
    @CreateDateColumn()
    issuedDate: Date

    @Column()
    expiresDate: Date

    /** Null = live. Set on logout, explicit revoke, credential change or privilege change */
    @Index()
    @Column({ type: 'timestamp', nullable: true })
    revokedDate?: Date | null

    @Column({ nullable: true, type: 'varchar', length: 32 })
    revokedReason?: SessionRevokeReason | null

    /** Rendered in the per-user active-session list so an operator can recognise the device */
    @Column({ nullable: true, type: 'text' })
    userAgent?: string | null

    /** Sized for a full IPv6 literal including an IPv4-mapped suffix */
    @Column({ nullable: true, type: 'varchar', length: 45 })
    ipAddress?: string | null

    /** Refreshed on each successful use — drives idle timeout and the "last active" column */
    @Column({ type: 'timestamp', nullable: true })
    lastActiveDate?: Date | null

    @ManyToOne(() => User)
    @JoinColumn({ name: 'userId' })
    user: User
}
