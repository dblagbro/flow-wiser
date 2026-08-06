import express, { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { WorkspaceService } from '../services/WorkspaceService'
import { WorkspaceUserService } from '../services/WorkspaceUserService'
import { notImplementedRouter } from './notImplemented'

/**
 * `/workspace` and `/workspaceuser` — the read half of workspace membership.
 *
 * CLEAN-ROOM PROVENANCE. Query shapes come from the Apache-2.0 client,
 * `packages/ui/src/api/workspace.js` and `packages/ui/src/api/user.js`:
 *
 *   GET /workspace?id=…                            getWorkspaceById
 *   GET /workspace?organizationId=…                getAllWorkspacesByOrganizationId
 *   GET /workspaceuser?workspaceId=…               getAllUsersByWorkspaceId
 *   GET /workspaceuser?userId=…                    getWorkspacesByUserId
 *   GET /workspaceuser?roleId=…                    getUserByRoleId
 *   GET /workspaceuser?userId=…&workspaceId=…      getUserByUserIdWorkspaceId
 *   GET /workspaceuser?organizationId=…&userId=…   getWorkspacesByOrganizationIdUserId
 *
 * One path, several meanings, selected by which parameters are present — so the handlers dispatch
 * on the parameter set rather than on separate routes.
 *
 * ── Tenancy ─────────────────────────────────────────────────────────────────────────────────
 *
 * REQUIREMENTS-MIGRATION §3a: "Tenant scope is derived server-side from the session, never from a
 * client-supplied organization id. A request may ASK for an organization; the server decides
 * whether the subject may see it."
 *
 * So `organizationId` in the query string is treated as a request and checked against the
 * organization the session resolved to. A mismatch answers EMPTY rather than 403 — a 403 would
 * confirm that the id names a real organization, which is the cross-tenant probe §3a is about.
 * Every workspace answer is additionally filtered to the workspaces the session's organization
 * owns, so a raw `?id=` cannot reach across the boundary either.
 *
 * The write half — create, update, delete, link/unlink users, switch, and the item-sharing
 * endpoints — is not implemented; see `notImplemented.ts`.
 */

const workspaces = () => new WorkspaceService()
const members = () => new WorkspaceUserService()

/** The organization the SESSION resolved to. The only tenant key any handler here may act on. */
const sessionOrganizationId = (req: Request): string | undefined =>
    (req as Request & { user?: { activeOrganizationId?: string } }).user?.activeOrganizationId

/** The subject's own id, for the "my workspaces" queries. */
const sessionUserId = (req: Request): string | undefined => (req as Request & { user?: { id?: string } }).user?.id

const asString = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined)

// ── /workspace ───────────────────────────────────────────────────────────────────────────────

export const workspaceRouter = express.Router()

workspaceRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
        const organizationId = sessionOrganizationId(req)
        if (!organizationId) {
            res.status(StatusCodes.OK).json([])
            return
        }

        const requestedOrganizationId = asString(req.query.organizationId)
        if (requestedOrganizationId && requestedOrganizationId !== organizationId) {
            res.status(StatusCodes.OK).json([])
            return
        }

        const id = asString(req.query.id)
        if (id) {
            const workspace = await workspaces().getWorkspaceById(id)
            // Cross-tenant reads answer 404, not 403: "exists but not yours" and "does not exist"
            // must be indistinguishable, or the endpoint enumerates other tenants' workspace ids.
            if (!workspace || workspace.organizationId !== organizationId) {
                res.status(StatusCodes.NOT_FOUND).json({ message: 'Workspace Not Found' })
                return
            }
            res.status(StatusCodes.OK).json(workspace)
            return
        }

        res.status(StatusCodes.OK).json(await workspaces().getWorkspacesByOrganizationId(organizationId))
    })().catch(next)
})

workspaceRouter.use(
    notImplementedRouter(
        'Workspace administration',
        'Creating, updating, deleting, switching and sharing workspaces are not implemented in this build. Reads (GET /workspace) are.'
    )
)

// ── /workspaceuser ───────────────────────────────────────────────────────────────────────────

export const workspaceUserRouter = express.Router()

workspaceUserRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
        const organizationId = sessionOrganizationId(req)
        if (!organizationId) {
            res.status(StatusCodes.OK).json([])
            return
        }

        const requestedOrganizationId = asString(req.query.organizationId)
        if (requestedOrganizationId && requestedOrganizationId !== organizationId) {
            res.status(StatusCodes.OK).json([])
            return
        }

        const workspaceId = asString(req.query.workspaceId)
        const userId = asString(req.query.userId)
        const roleId = asString(req.query.roleId)

        // Most specific parameter set first, so `?userId=&workspaceId=` is not answered by the
        // broader `?userId=` branch.
        if (workspaceId && userId) {
            const membership = await members().readWorkspaceUserByWorkspaceIdUserId(workspaceId, userId)
            res.status(StatusCodes.OK).json(membership ? [membership] : [])
            return
        }

        let rows
        if (workspaceId) rows = await members().readWorkspaceUserByWorkspaceId(workspaceId)
        else if (roleId) rows = await members().readWorkspaceUserByRoleId(roleId)
        else if (userId) rows = await members().readWorkspaceUserByUserId(userId)
        else rows = await members().readWorkspaceUserByUserId(sessionUserId(req))

        // Final tenant filter, applied to whichever branch produced the rows. A `workspaceId` or
        // `roleId` from the query string is not scoped by construction, so it is scoped here —
        // this is the one place that cannot be forgotten per §3a.
        const scoped = await filterToOrganization(rows, organizationId)
        res.status(StatusCodes.OK).json(scoped)
    })().catch(next)
})

workspaceUserRouter.use(
    notImplementedRouter(
        'Workspace membership administration',
        'Assigning and removing workspace members is not implemented in this build. Reads (GET /workspaceuser) are.'
    )
)

/**
 * Drop any membership row whose workspace belongs to another organization.
 *
 * Resolves each distinct workspace once. The alternative — joining in SQL — would put the tenant
 * key back into a query that a future edit could forget; doing it here means every branch above
 * passes through the same filter.
 */
const filterToOrganization = async <T extends { workspaceId: string }>(rows: T[], organizationId: string): Promise<T[]> => {
    if (rows.length === 0) return rows
    const service = workspaces()
    const permitted = new Map<string, boolean>()
    const kept: T[] = []
    for (const row of rows) {
        if (!permitted.has(row.workspaceId)) {
            const workspace = await service.getWorkspaceById(row.workspaceId)
            permitted.set(row.workspaceId, workspace?.organizationId === organizationId)
        }
        if (permitted.get(row.workspaceId)) kept.push(row)
    }
    return kept
}

export default workspaceRouter
