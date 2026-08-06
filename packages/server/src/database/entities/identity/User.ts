/* eslint-disable */
import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm'

/**
 * Identity — User (spec §D.1).
 *
 * Table naming: every table in this cluster is prefixed `identity_`. The prefix is deliberate —
 * it keeps the Apache-2.0 identity schema disjoint from the tables the outgoing stack created
 * (`user`, `organization`, `workspace`, …), so both can coexist during cut-over and an existing
 * deployment can be migrated forward instead of colliding on `CREATE TABLE`.
 *
 * Following house style (see Execution.ts), relations are declared on the entity but no FOREIGN KEY
 * constraints are emitted by the migrations.
 */
@Entity('identity_user')
export class User {
    @PrimaryGeneratedColumn('uuid')
    id: string

    /** Nullable — the UI renders `name ?? ''` and falls back to `name || email` (spec §D.1) */
    @Column({ nullable: true, type: 'text' })
    name?: string | null

    /** The login identifier. Unique, case-insensitivity is normalised (lower-cased) by the service layer */
    @Index({ unique: true })
    @Column({ type: 'varchar', length: 255 })
    email: string

    /**
     * Password hash. Named `credential` because that is the inbound wire field on register (spec §D.1).
     *
     * NEVER plaintext. Sized for either supported algorithm: bcryptjs (already a dependency) emits
     * 60 chars, argon2id PHC strings run to ~100; varchar(255) covers both plus future parameters.
     * `select: false` keeps the hash out of every `find()` that does not explicitly ask for it —
     * same guard as ChatFlow.webhookSecret. Nullable because SSO-only and invited-but-not-yet-
     * registered users have no local credential.
     */
    @Column({ nullable: true, type: 'varchar', length: 255, select: false })
    credential?: string | null

    /** Suppresses the password UI on the account screen (spec §D.1) */
    @Column({ type: 'boolean', default: false })
    isSSO: boolean

    /**
     * Set while an email change is pending confirmation; the confirmation token lives in
     * `identity_token` with purpose `email_change` (spec §D.1, §F-3).
     */
    @Column({ nullable: true, type: 'varchar', length: 255 })
    pendingEmail?: string | null

    /** Null = unverified, which is what produces the `'User Email Unverified'` login response (spec §E.3) */
    @Column({ type: 'datetime', nullable: true })
    emailVerifiedDate?: Date | null

    /**
     * Bumped on every credential change. Sessions issued before this instant are treated as invalid,
     * which satisfies "password change must invalidate the session" (spec §D.12) and
     * "rotation on privilege change" (requirements §5) without a table scan of identity_session.
     */
    @Column({ type: 'datetime', nullable: true })
    credentialUpdatedDate?: Date | null

    /** Cloud registration only (spec §D.1) */
    @Column({ nullable: true, type: 'text' })
    referral?: string | null

    /**
     * NOTE — deliberately absent:
     *  - `tempToken`: replaced by the purpose-discriminated `Token` entity (spec §F-3).
     *  - `status` / `lastLogin`: owned by OrganizationUser (spec §F-1, see that entity for rationale).
     *  - `role`: the real role lives on WorkspaceUser; the login payload's `user.role` is projected
     *    from the role held in the active workspace, never stored here (spec §F-2, §D.6).
     */

    @Column({ type: 'timestamp' })
    @CreateDateColumn()
    createdDate: Date

    @Column({ type: 'timestamp' })
    @UpdateDateColumn()
    updatedDate: Date
}
