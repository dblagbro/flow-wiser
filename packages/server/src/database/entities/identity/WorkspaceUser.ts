/* eslint-disable */
import { Entity, Column, PrimaryColumn, CreateDateColumn, UpdateDateColumn, Index, ManyToOne, JoinColumn } from 'typeorm'
import { User } from './User'
import { Workspace } from './Workspace'
import { Role } from './Role'

/**
 * Identity — WorkspaceUser (spec §D.6): the join that actually carries authority.
 *
 * ── Permissions are WORKSPACE-SCOPED ─────────────────────────────────────────────────────────
 * The effective permission set for a request is:
 *
 *     WorkspaceUser(userId = <caller>, workspaceId = <session.activeWorkspaceId>) -> Role.permissions
 *
 * i.e. resolved from the session's ACTIVE workspace, never from a client-supplied workspace id
 * (requirements §4: "workspace scoping enforced server-side on every query"). This is exactly why
 * `POST /workspace/switch` re-issues the whole login payload (spec §A.7, §D.6, §E.6) — switching
 * workspace changes the role, therefore changes the permission set.
 *
 * A user holds EXACTLY ONE role per workspace; that is enforced structurally by the composite
 * primary key (workspaceId, userId) plus a non-null roleId, so a second grant is a duplicate-key
 * error rather than a silent permission union.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
@Entity('identity_workspace_user')
export class WorkspaceUser {
    @PrimaryColumn({ type: 'uuid' })
    workspaceId: string

    @Index()
    @PrimaryColumn({ type: 'uuid' })
    userId: string

    /** Non-null: an assignment without a role would be an unscoped membership */
    @Index()
    @Column({ type: 'uuid' })
    roleId: string

    /**
     * NOTE: `status`, `lastLogin` and `isOrgOwner` appear on the GET /workspaceuser row but are NOT
     * stored here — they are projections joined from OrganizationUser via
     * (workspaceId → organizationId, userId). See the §F-1 decision in OrganizationUser.
     */

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

    /** Supplies the embedded `user` / `workspace` / `role` objects on the row shape (spec §D.6) */
    @ManyToOne(() => User)
    @JoinColumn({ name: 'userId' })
    user: User

    @ManyToOne(() => Workspace)
    @JoinColumn({ name: 'workspaceId' })
    workspace: Workspace

    @ManyToOne(() => Role)
    @JoinColumn({ name: 'roleId' })
    role: Role
}
