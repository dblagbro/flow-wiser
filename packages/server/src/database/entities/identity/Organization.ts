/* eslint-disable */
import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm'

/**
 * Identity — Organization (spec §D.2).
 *
 * Multi-org tenancy is a v1 non-goal (requirements "Non-goals"); the entity exists because
 * `organizationId` is a mandatory query parameter on /role, /organizationuser, /workspace and
 * /loginmethod, and because roles are organization-scoped (spec §D.5).
 */
@Entity('identity_organization')
export class Organization {
    @PrimaryGeneratedColumn('uuid')
    id: string

    /**
     * Supplied at first-run setup. Spec §F-8 records that the shipped breadcrumb ignores this and
     * derives `"<owner>'s Organization"` instead. Decision: keep the stored name authoritative and
     * return it; the derived label is the fallback when this is null.
     */
    @Column({ nullable: true, type: 'varchar', length: 255 })
    name?: string | null

    /** Billing identifiers are carried for payload compatibility only — Flow-Wiser gates nothing on them */
    @Column({ nullable: true, type: 'varchar', length: 255 })
    subscriptionId?: string | null

    @Column({ nullable: true, type: 'varchar', length: 255 })
    customerId?: string | null

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
}
