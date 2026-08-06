/* eslint-disable */
import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm'

/**
 * Identity — WorkspaceShared: a resource in one workspace made visible to another.
 *
 * CLEAN-ROOM PROVENANCE. Shape derived entirely from Apache-2.0 CALL SITES, never from the
 * original entity. Three Apache-2.0 services query it, and all three use the same triple:
 *
 *   services/credentials/index.ts:150-153        { workspaceId, sharedItemId, itemType: 'credential' }
 *   services/credentials/index.ts:213-216        { workspaceId, sharedItemId, itemType: 'credential' }
 *   routes/oauth2/index.ts:89-91                 findOneBy({ workspaceId, sharedItemId, ... })
 *   services/openai-assistants-vector-store/     getRepository(WorkspaceShared)
 *
 * That fixes the contract: a lookup keyed on (workspaceId, sharedItemId, itemType) answering
 * "is this item shared into this workspace?"
 *
 * ── Why this exists when REQUIREMENTS-TENANCY-ACCESS §3.3 defers sharing ──────────────────
 *
 * §3.3 defers building NEW multi-tenant sharing. It does not — and cannot — defer sharing
 * that the Apache-2.0 code already depends on. Three shipped services read this table today;
 * removing it would break credential sharing, OAuth2 token resolution and vector-store
 * access on every existing deployment.
 *
 * This was a genuine gap in the requirements: sharing was deferred as a feature decision
 * without first checking whether the retained code already used it. Recorded here rather
 * than quietly patched, and §3.3 should be read as "no NEW cross-ORGANISATION sharing" —
 * workspace-level sharing within an organisation is existing, in-use behaviour.
 *
 * ── Tenancy note ──────────────────────────────────────────────────────────────────────────
 *
 * Sharing crosses a WORKSPACE boundary, never an ORGANISATION one. `organizationId` is
 * carried explicitly (REQUIREMENTS-MIGRATION §3a: the tenant key belongs on the row, so a
 * query that forgets to join cannot leak across tenants) and a share is only valid when the
 * source and target workspaces belong to the SAME organisation. That invariant is enforced
 * at write time — a cross-tenant share is the exact breach §3a exists to prevent, and it
 * must not be expressible through a sharing feature.
 */
@Entity('identity_workspace_shared')
@Index('idx_identity_workspace_shared_lookup', ['workspaceId', 'sharedItemId', 'itemType'])
@Index('idx_identity_workspace_shared_item', ['sharedItemId', 'itemType'])
@Index('idx_identity_workspace_shared_org', ['organizationId'])
export class WorkspaceShared {
    @PrimaryGeneratedColumn('uuid')
    id: string

    /** The workspace the item is shared INTO — the one gaining access. */
    @Column({ type: 'uuid' })
    workspaceId: string

    /** Id of the shared resource. Not a foreign key: itemType selects which table it lives in. */
    @Column({ type: 'uuid' })
    sharedItemId: string

    /**
     * Which kind of resource. Observed value at the call sites: `'credential'`. Left as a
     * string rather than an enum because the Apache-2.0 callers pass a bare literal and a
     * narrower type here would reject values those callers may already use.
     */
    @Column({ type: 'varchar', length: 64 })
    itemType: string

    /**
     * Tenant key, denormalised per REQUIREMENTS-MIGRATION §3a. A share is only ever valid
     * within one organisation; carrying it here means a tenant-scoped query needs no join,
     * and a forgotten join cannot cross tenants.
     */
    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null

    @Column({ type: 'datetime' })
    @CreateDateColumn()
    createdDate: Date

    @Column({ type: 'datetime' })
    @UpdateDateColumn()
    updatedDate: Date
}
