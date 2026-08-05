/* eslint-disable */
import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index, ManyToOne, JoinColumn } from 'typeorm'
import { Organization } from './Organization'

/** Behaviourally significant literal — the delete-guard and the workspace switcher case on it (spec §D.4) */
export const DEFAULT_WORKSPACE_NAME = 'Default Workspace'

/**
 * Identity — Workspace (spec §D.4).
 *
 * `workspaceId` is the pervasive tenancy discriminator across the whole product, and per
 * requirements §4 it is enforced server-side on every query — never taken from a client-supplied
 * id. This entity is the authority for which organization a workspace belongs to, so the scoping
 * check always resolves organization from the workspace, not from the request.
 */
@Entity('identity_workspace')
export class Workspace {
    @PrimaryGeneratedColumn('uuid')
    id: string

    @Column({ type: 'varchar', length: 255 })
    name: string

    @Column({ nullable: true, type: 'text' })
    description?: string | null

    @Index()
    @Column({ type: 'uuid' })
    organizationId: string

    /** The org's undeletable default workspace (spec §D.4 delete-guard) */
    @Column({ type: 'boolean', default: false })
    isOrgDefault: boolean

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
