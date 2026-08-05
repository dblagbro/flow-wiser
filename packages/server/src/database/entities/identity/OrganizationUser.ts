/* eslint-disable */
import { Entity, Column, PrimaryColumn, CreateDateColumn, UpdateDateColumn, Index, ManyToOne, JoinColumn } from 'typeorm'
import { User } from './User'
import { Organization } from './Organization'

/**
 * Membership status. Values are stored lower-case exactly as the edit dialog submits them
 * (`'active'` / `'inactive'`); the table renders them upper-cased (spec §D.1, §D.3).
 */
export enum MemberStatus {
    ACTIVE = 'active',
    INVITED = 'invited',
    INACTIVE = 'inactive'
}

/**
 * Identity — OrganizationUser (spec §D.3): the org↔user membership edge.
 *
 * ── Spec gap §F-1 resolved here ──────────────────────────────────────────────────────────────
 * `status` and `lastLogin` surface on three shapes (login payload, org-user row, workspace-user
 * row) and the spec leaves ownership open. DECISION: **OrganizationUser owns both.**
 * Rationale: `PUT /organizationuser` takes `{ userId, organizationId, status }` — an org-scoped
 * write signature (spec §F-1), so an org-scoped column is the only one the write can address
 * without ambiguity. Consequences, which are intended:
 *   - a user may be `active` in one organization and `inactive` in another;
 *   - the login payload's `status`/`lastLogin` are PROJECTED from the row for the active org;
 *   - the workspace-user row's `status`/`lastLogin` are likewise projections, joined through
 *     (workspaceId → organizationId, userId) — they are never stored on WorkspaceUser (spec §D.6
 *     already describes `isOrgOwner` there as denormalised, and these follow the same rule).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
@Entity('identity_organization_user')
export class OrganizationUser {
    /** Composite PK — one membership row per (organization, user) pair, enforced by the database */
    @PrimaryColumn({ type: 'uuid' })
    organizationId: string

    @Index()
    @PrimaryColumn({ type: 'uuid' })
    userId: string

    /** Owner of the account status (spec §F-1 decision above) */
    @Column({ type: 'varchar', length: 20, default: MemberStatus.ACTIVE })
    status: MemberStatus

    /** Owner of last-login (spec §F-1). Null renders as 'Never' in the users table */
    @Column({ nullable: true })
    lastLogin?: Date | null

    /**
     * Exactly one row per organization carries `true` (spec §D.3). The UI blocks deleting or
     * suspending that member. Not enforceable portably in DDL — MySQL/MariaDB have no partial
     * unique index — so the invariant is enforced in the org service and asserted at bootstrap.
     * This is the single bootstrap super-role permitted by requirements §4.
     */
    @Column({ type: 'boolean', default: false })
    isOrgOwner: boolean

    @Column({ nullable: true, type: 'uuid' })
    createdBy?: string | null

    @Column({ nullable: true, type: 'uuid' })
    updatedBy?: string | null

    @Column({ type: 'timestamp' })
    @CreateDateColumn()
    createdDate: Date

    @Column({ type: 'timestamp' })
    @UpdateDateColumn()
    updatedDate: Date

    /** Supplies the embedded `user: { id, name, email }` on the GET /organizationuser row (spec §D.3) */
    @ManyToOne(() => User)
    @JoinColumn({ name: 'userId' })
    user: User

    @ManyToOne(() => Organization)
    @JoinColumn({ name: 'organizationId' })
    organization: Organization
}
