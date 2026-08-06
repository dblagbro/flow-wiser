import { DataSource, In, QueryRunner } from 'typeorm'
import { Workspace, WorkspaceShared } from '../../database/entities/identity'
import logger from '../../utils/logger'

/**
 * Workspace reads for the Apache-2.0 service tree.
 *
 * CLEAN-ROOM PROVENANCE. Derived from the three Apache-2.0 call sites and nothing else:
 *
 *   services/credentials/index.ts:75-76    new WorkspaceService()
 *                                          (await …getSharedItemsForWorkspace(workspaceId,
 *                                              'credential')) as Credential[]
 *   services/credentials/index.ts:107-108  identical
 *   services/marketplaces/index.ts:185-186 (await …getSharedItemsForWorkspace(workspaceId,
 *                                              'custom_template')) as CustomTemplate[]
 *
 * Every one of them: constructed with `new` and no arguments, one method, two positional string
 * arguments, awaited, and the result CAST to an array of full resource entities — not ids, not
 * join rows. That fixes the whole contract, including the fact that the method has to load the
 * resources themselves rather than return the share records.
 *
 * ── Why the itemType is a lookup table and not a string interpolation ────────────────────────
 *
 * `WorkspaceShared.itemType` is the name of the table the id lives in, and the obvious
 * implementation is one query built from it. It is also a straight SQL injection sink and a way to
 * read any table in the database by asking for a share of the right `itemType`. The two values the
 * Apache-2.0 callers actually pass are enumerated below instead; an unknown type returns empty and
 * says so in the log, which is both safe and diagnosable.
 */

/**
 * Resource types that may be shared into another workspace.
 *
 * `credential` and `custom_template` are the two the Apache-2.0 callers pass. The values are the
 * TypeORM entity names, resolved against the DataSource's own metadata rather than written as
 * table names, so a rename cannot turn this into a silent empty result.
 */
const SHAREABLE_ITEM_TYPES: Readonly<Record<string, string>> = {
    credential: 'Credential',
    custom_template: 'CustomTemplate'
}

export interface WorkspaceServiceOptions {
    /** Omit in the running server; resolved lazily, exactly as the other identity services do. */
    dataSource?: DataSource
}

export class WorkspaceService {
    private readonly injectedDataSource?: DataSource

    constructor(options: WorkspaceServiceOptions = {}) {
        this.injectedDataSource = options.dataSource
    }

    /**
     * Lazy `require` for the same reason `SessionService` uses one: a static import of
     * `getRunningExpressApp` drags in the server entrypoint, which would make this service
     * impossible to construct outside a booted application.
     */
    private getDataSource(): DataSource {
        if (this.injectedDataSource) return this.injectedDataSource
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { getRunningExpressApp } = require('../../utils/getRunningExpressApp')
        return getRunningExpressApp().AppDataSource
    }

    /**
     * Resources of `itemType` that have been shared INTO `workspaceId`.
     *
     * Two steps, deliberately not one join: read the share rows, then load the resources by id.
     * A join would have to name the resource table in the query text, which is the injection sink
     * described above; `In(ids)` is parameterised and the entity is chosen from a fixed map.
     *
     * Returns `[]` — never null, never throws — for an absent workspace, an unknown item type, or
     * no shares. All three callers spread the result into a larger array without a null check.
     */
    async getSharedItemsForWorkspace(workspaceId: string, itemType: string): Promise<unknown[]> {
        if (!workspaceId) return []

        const entityName = SHAREABLE_ITEM_TYPES[itemType]
        if (!entityName) {
            logger.warn(`[identity] refusing to resolve shared items of unknown type '${itemType}' — returning none`)
            return []
        }

        const dataSource = this.getDataSource()
        const shares = await dataSource.getRepository(WorkspaceShared).find({
            where: { workspaceId, itemType },
            select: { sharedItemId: true }
        })
        if (shares.length === 0) return []

        const ids = shares.map((share) => share.sharedItemId)
        return dataSource.getRepository(entityName).find({ where: { id: In(ids) } })
    }

    /** Every workspace in an organization. Ordered by name so the switcher is stable across calls. */
    async getWorkspacesByOrganizationId(organizationId: string, queryRunner?: QueryRunner): Promise<Workspace[]> {
        if (!organizationId) return []
        const manager = queryRunner ? queryRunner.manager : this.getDataSource().manager
        return manager.find(Workspace, { where: { organizationId }, order: { name: 'ASC' } })
    }

    /** One workspace by id, or null. Null rather than a throw: the callers branch on absence. */
    async getWorkspaceById(id: string, queryRunner?: QueryRunner): Promise<Workspace | null> {
        if (!id) return null
        const manager = queryRunner ? queryRunner.manager : this.getDataSource().manager
        return manager.findOne(Workspace, { where: { id } })
    }
}

export default WorkspaceService
