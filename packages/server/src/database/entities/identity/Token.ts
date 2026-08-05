/* eslint-disable */
import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index, ManyToOne, JoinColumn } from 'typeorm'
import { User } from './User'

/**
 * The four single-use flows that the outgoing design multiplexed through one nullable `tempToken`
 * column (spec §D.1, §F-3).
 */
export enum TokenPurpose {
    /** Workspace invite code redeemed at register */
    INVITE = 'invite',
    EMAIL_VERIFICATION = 'email_verification',
    PASSWORD_RESET = 'password_reset',
    /** Confirms a change to User.pendingEmail */
    EMAIL_CHANGE = 'email_change'
}

/**
 * Identity — Token (spec §F-3 resolved).
 *
 * ── Spec gap §F-3 resolved here ──────────────────────────────────────────────────────────────
 * A single nullable `tempToken` column carried four unrelated semantics and therefore could not
 * serve two flows at once — a user with a pending email change who requested a password reset
 * would have one silently overwrite the other. DECISION: one row per issued token, discriminated
 * by `purpose`, so all four flows are concurrent by construction.
 *
 * `tempToken` survives only as the WIRE field name on the four endpoints that accept it; nothing
 * is stored under that name.
 *
 * Policy (the parts §F-3 left undetermined), enforced in the token service:
 *   - TTLs: invite 7d, email_verification 24h, password_reset 1h, email_change 1h.
 *   - Single use: redemption sets `consumedDate`; a row with a non-null `consumedDate` or a past
 *     `expiresDate` is never accepted again.
 *   - Issuing a new token of a purpose SUPERSEDES prior unconsumed ones for that (userId, purpose)
 *     — they are marked consumed rather than deleted, so "Update Invite" is idempotent (spec §F-13)
 *     and the audit trail survives.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
@Entity('identity_token')
export class Token {
    @PrimaryGeneratedColumn('uuid')
    id: string

    @Column({ type: 'uuid' })
    userId: string

    @Column({ type: 'varchar', length: 32 })
    purpose: TokenPurpose

    /**
     * SHA-256 of the emitted secret. The secret itself is shown once, in the email, and is never
     * recoverable from the database — a DB read must not let an attacker complete a password reset.
     * Unique, so lookup is a single indexed probe on the hash of the presented value.
     */
    @Index({ unique: true })
    @Column({ type: 'varchar', length: 128 })
    tokenHash: string

    @Column()
    expiresDate: Date

    /** Null = still redeemable. Set on redemption, or when superseded by a newer token of the same purpose */
    @Column({ nullable: true })
    consumedDate?: Date | null

    /**
     * JSON-encoded, purpose-specific payload — the invite carries `{ workspaceId, roleId }`
     * (spec §F-13: `POST /account/invite` takes a workspace and a role), email_change carries
     * `{ newEmail }`. Kept opaque so a new purpose needs no schema change.
     */
    @Column({ nullable: true, type: 'text' })
    data?: string | null

    @Column({ nullable: true, type: 'uuid' })
    createdBy?: string | null

    @Column({ type: 'timestamp' })
    @CreateDateColumn()
    createdDate: Date

    @ManyToOne(() => User)
    @JoinColumn({ name: 'userId' })
    user: User
}
