import { DataSource, QueryRunner } from 'typeorm'
import { WorkspaceUser } from '../../database/entities/identity'

/**
 * Workspace membership reads for the Apache-2.0 service tree.
 *
 * CLEAN-ROOM PROVENANCE. Derived from the single Apache-2.0 call site and nothing else —
 * `packages/server/src/controllers/chatflows/index.ts:243-250`:
 *
 *     queryRunner = getRunningExpressApp().AppDataSource.createQueryRunner()
 *     const workspaceUserService = new WorkspaceUserService()
 *     const workspaceUser = await workspaceUserService.readWorkspaceUserByUserId(req.user.id, queryRunner)
 *     if (workspaceUser.length === 0)
 *         return res.status(404).json({ message: WorkspaceUserErrorMessage.WORKSPACE_USER_NOT_FOUND })
 *     const workspaceIds = workspaceUser.map((user) => user.workspaceId)
 *
 * Everything the contract needs is visible there: no-argument construction; a method taking a user
 * id and a `QueryRunner`; a return that is an ARRAY (`.length`, `.map`) whose elements carry
 * `workspaceId`; and an empty array — not null, not a throw — as the "no membership" answer, since
 * the caller turns `length === 0` into its own 404.
 *
 * The `QueryRunner` is passed rather than optional at that site because the controller opened one
 * for the request and releases it in a `finally`. It is optional here so the service is usable
 * outside a controller, but when supplied the read MUST go through it: sharing the runner is what
 * keeps this query inside whatever transaction the caller has open.
 */

/**
 * Message literals for the membership failures.
 *
 * `WORKSPACE_USER_NOT_FOUND` is sent verbatim as a 404 body at the call site above, so it is a
 * wire string, not an internal label. The others follow the same `<Subject> Not Found` shape and
 * exist so the routers below have one place to take them from.
 */
export const WorkspaceUserErrorMessage = {
    WORKSPACE_USER_NOT_FOUND: 'Workspace User Not Found',
    INVALID_WORKSPACE_USER_ROLE_ID: 'Invalid Workspace User Role Id',
    INVALID_WORKSPACE_USER_WORKSPACE_ID: 'Invalid Workspace User Workspace Id',
    INVALID_WORKSPACE_USER_USER_ID: 'Invalid Workspace User User Id'
} as const

export interface WorkspaceUserServiceOptions {
    /** Omit in the running server; resolved lazily, exactly as the other identity services do. */
    dataSource?: DataSource
}

export class WorkspaceUserService {
    private readonly injectedDataSource?: DataSource

    constructor(options: WorkspaceUserServiceOptions = {}) {
        this.injectedDataSource = options.dataSource
    }

    /** Lazy `require` — a static import of `getRunningExpressApp` would drag in the server entrypoint. */
    private getDataSource(): DataSource {
        if (this.injectedDataSource) return this.injectedDataSource
        const { getRunningExpressApp } = require('../../utils/getRunningExpressApp')
        return getRunningExpressApp().AppDataSource
    }

    /**
     * Every workspace membership held by `userId`.
     *
     * `userId` is typed loosely because the call site passes `req.user.id`, which is optional on
     * `LoggedInUser` (the API-key branch has no user id). A missing id yields no memberships,
     * which is the correct answer and keeps the caller's `length === 0` branch meaningful — an
     * API-key principal genuinely has no workspace membership rows.
     */
    async readWorkspaceUserByUserId(userId: string | undefined | null, queryRunner?: QueryRunner): Promise<WorkspaceUser[]> {
        if (!userId) return []
        const manager = queryRunner ? queryRunner.manager : this.getDataSource().manager
        return manager.find(WorkspaceUser, { where: { userId } })
    }

    /** Every member of a workspace. Empty array when the workspace does not exist. */
    async readWorkspaceUserByWorkspaceId(workspaceId: string | undefined | null, queryRunner?: QueryRunner): Promise<WorkspaceUser[]> {
        if (!workspaceId) return []
        const manager = queryRunner ? queryRunner.manager : this.getDataSource().manager
        return manager.find(WorkspaceUser, { where: { workspaceId } })
    }

    /**
     * The one membership row for a (workspace, user) pair, or null.
     *
     * Null rather than an empty array: this identifies at most one row, and returning a
     * one-or-zero array would invite `[0]` on an empty one.
     */
    async readWorkspaceUserByWorkspaceIdUserId(
        workspaceId: string | undefined | null,
        userId: string | undefined | null,
        queryRunner?: QueryRunner
    ): Promise<WorkspaceUser | null> {
        if (!workspaceId || !userId) return null
        const manager = queryRunner ? queryRunner.manager : this.getDataSource().manager
        return manager.findOne(WorkspaceUser, { where: { workspaceId, userId } })
    }

    /** Everyone holding a given role. Used to answer "is this role still in use?" before a delete. */
    async readWorkspaceUserByRoleId(roleId: string | undefined | null, queryRunner?: QueryRunner): Promise<WorkspaceUser[]> {
        if (!roleId) return []
        const manager = queryRunner ? queryRunner.manager : this.getDataSource().manager
        return manager.find(WorkspaceUser, { where: { roleId } })
    }
}

export default WorkspaceUserService
