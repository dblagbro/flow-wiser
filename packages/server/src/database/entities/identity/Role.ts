/* eslint-disable */
import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index, ManyToOne, JoinColumn } from 'typeorm'
import { Organization } from './Organization'

/** Behaviourally significant literal — the workspace view special-cases this role name (spec §D.4, §F-12) */
export const PERSONAL_WORKSPACE_ROLE_NAME = 'personal workspace'

/**
 * Identity — Role (spec §D.5).
 *
 * Roles are ORGANIZATION-scoped (every read and delete is keyed by `organizationId`), but authority
 * is WORKSPACE-scoped: a role only grants anything through a WorkspaceUser row, and the effective
 * permission set for a request is the permissions of the role held in the ACTIVE workspace
 * (spec §D.6, §B). See WorkspaceUser for the enforcement path.
 */
@Entity('identity_role')
export class Role {
    @PrimaryGeneratedColumn('uuid')
    id: string

    /**
     * No spaces, and immutable after creation (spec §D.5) — both are validated in the role service,
     * not in DDL. Unique per organization (see the composite index in the migration).
     */
    @Column({ type: 'varchar', length: 100 })
    name: string

    @Column({ nullable: true, type: 'text' })
    description?: string | null

    /**
     * JSON-encoded `string[]` of permission keys, stored as text because the client does
     * `JSON.parse(role.permissions)` and `JSON.stringify` on save (spec §D.5) — a native array
     * column would change the wire shape the shipped UI expects.
     *
     * Deny-by-default (requirements §4): an unknown key in this list grants nothing, and an empty
     * list grants nothing.
     */
    @Column({ type: 'text', default: '[]' })
    permissions: string

    @Index()
    @Column({ type: 'uuid' })
    organizationId: string

    /**
     * Seeded built-in roles (owner, member, `personal workspace`). System roles cannot be renamed
     * or deleted through /role. Kept as an explicit flag rather than a name comparison so the
     * bootstrap set is data, not a hard-coded string list (requirements §4, spec §F-12).
     */
    @Column({ type: 'boolean', default: false })
    isSystem: boolean

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

    @ManyToOne(() => Organization)
    @JoinColumn({ name: 'organizationId' })
    organization: Organization
}
