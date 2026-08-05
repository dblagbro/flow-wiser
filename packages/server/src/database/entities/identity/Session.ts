/* eslint-disable */
import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index, ManyToOne, JoinColumn } from 'typeorm'
import { User } from './User'

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
     * SHA-256 of the refresh secret carried by the refresh cookie. Hashed, never plaintext: a DB
     * read must not yield a usable credential. Unique so a stolen-and-replayed secret can be
     * detected on rotation.
     */
    @Index({ unique: true })
    @Column({ type: 'varchar', length: 128 })
    refreshTokenHash: string

    /** Access-credential lifetime is short and independent; this is the refresh window (spec §E.4) */
    @Column({ type: 'timestamp' })
    @CreateDateColumn()
    issuedDate: Date

    @Column()
    expiresDate: Date

    /** Null = live. Set on logout, explicit revoke, credential change or privilege change */
    @Index()
    @Column({ nullable: true })
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
    @Column({ nullable: true })
    lastActiveDate?: Date | null

    @ManyToOne(() => User)
    @JoinColumn({ name: 'userId' })
    user: User
}
