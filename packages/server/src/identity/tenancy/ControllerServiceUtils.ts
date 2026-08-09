import { Request } from 'express'
import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'

/**
 * Tenant scoping for repository queries — the Apache-2.0 replacement for the helpers the
 * Apache-2.0 services import from the commercially-licensed tree.
 *
 * CLEAN-ROOM PROVENANCE. The contract here was derived entirely from Apache-2.0 CALL SITES,
 * never from the original implementation. Those call sites show:
 *
 *   `{ type, ...getWorkspaceSearchOptions(workspaceId) }`   packages/server/src/services/**
 *
 * — the result is SPREAD into a TypeORM where-clause, is never awaited, and is passed a bare
 * workspace id (sometimes `chatflow.workspaceId`, which may be undefined). That fixes the
 * shape completely: a synchronous function returning a partial where-clause.
 *
 * ── Why this file is more than a passthrough ──────────────────────────────────────────────
 *
 * REQUIREMENTS-MIGRATION.md §3a: "The single most common multi-tenancy failure is one
 * endpoint that forgot the filter." This helper is where that filter is applied, so it is
 * the natural home for the guarantees §3a asks for, rather than a thin shim.
 *
 * Two behaviours are deliberate and worth stating plainly:
 *
 * 1. AN ABSENT WORKSPACE ID RETURNS AN UNSCOPED CLAUSE, exactly as the callers assume — some
 *    pass `chatflow.workspaceId` which is legitimately undefined on single-tenant data, and
 *    upstream deployments predating workspaces have NULL in that column. Returning a clause
 *    that matched nothing would make every such row invisible, which reads as data loss.
 *    So the scoping decision is made by the CALLER having a workspace id, and the security
 *    boundary is that the caller obtains it from the session (see 2), never from user input.
 *
 * 2. `getWorkspaceSearchOptionsFromReq` READS THE SESSION, NEVER THE CLIENT. §3a: "Tenant
 *    scope is derived server-side from the session, never from a client-supplied
 *    organization id. A request may ASK for an organization; the server decides whether the
 *    subject may see it." A query parameter is a request, not an authority.
 */

/** A partial TypeORM where-clause. Spread into a larger clause by the caller. */
export interface WorkspaceSearchOptions {
    workspaceId?: string
}

/**
 * Scope a query to a workspace.
 *
 * Returns `{}` when no workspace id is supplied — see note 1 above. This is not a silent
 * failure: it is the documented behaviour the Apache-2.0 callers already depend on, and the
 * decision to scope is theirs.
 */
export const getWorkspaceSearchOptions = (workspaceId?: string | null): WorkspaceSearchOptions => (workspaceId ? { workspaceId } : {})

/**
 * Scope a query to the ACTIVE workspace of the authenticated subject.
 *
 * The id comes from `req.user`, which the authentication middleware populates from the
 * server-side session record. It is never read from the query string, body, or a header —
 * accepting a client-supplied workspace id here would let any authenticated caller read any
 * tenant's rows by editing a URL, which is precisely the breach §3a exists to prevent.
 */
export const getWorkspaceSearchOptionsFromReq = (req: Request): WorkspaceSearchOptions => {
    const user = (req as Request & { user?: { activeWorkspaceId?: string } }).user
    return getWorkspaceSearchOptions(user?.activeWorkspaceId)
}

/**
 * The ACTIVE workspace id of the authenticated subject, or a 401.
 *
 * Same session-derived rule as {@link getWorkspaceSearchOptionsFromReq} — note 2 above applies
 * unchanged — but it RETURNS A BARE ID rather than a where-clause fragment, and it refuses to
 * return nothing.
 *
 * CALL SITE: `packages/server/src/routes/oauth2/index.ts:78`.
 *
 *     const workspaceId = getActiveWorkspaceIdForRequest(req)
 *     let credential = await credentialRepository.findOneBy({ id: credentialId, workspaceId })
 *
 * ── Why this one throws when the other returns `{}` ──────────────────────────────────────────
 *
 * The difference is what the caller does with the absence, and it is a security difference, not a
 * style one.
 *
 * `getWorkspaceSearchOptions` returns `{}` and the caller SPREADS it — the workspace condition is
 * simply not added, which is the documented behaviour for pre-workspace data (note 1).
 *
 * Here the value is placed into a where-clause BY NAME. TypeORM drops a condition whose value is
 * `undefined`, so `findOneBy({ id, workspaceId: undefined })` does not fail and does not match
 * nothing — it matches the credential in ANY workspace. Returning `undefined` from this function
 * would therefore turn one missing session field into a silent cross-tenant read of exactly the
 * kind REQUIREMENTS-MIGRATION §3a exists to prevent, at the OAuth2 endpoint, on credentials.
 *
 * So it fails closed instead. The two OAuth2 handlers that call it are already inside a
 * `try/catch` that forwards to the error middleware, so the throw becomes a clean 401.
 */
export const getActiveWorkspaceIdForRequest = (req: Request): string => {
    const user = (req as Request & { user?: { activeWorkspaceId?: string } }).user
    const workspaceId = user?.activeWorkspaceId
    if (!workspaceId) {
        throw new InternalFlowiseError(
            StatusCodes.UNAUTHORIZED,
            'No active workspace on this request — refusing an unscoped tenant query (requirements MIGRATION §3a)'
        )
    }
    return workspaceId
}

/**
 * The organization a workspace belongs to — the denormalised tenant key of REQUIREMENTS-MIGRATION
 * §3a.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────────────────
 *
 * Migration `1780000000012` added `organizationId` to ten content tables so that a tenant-scoped
 * query needs no join and a forgotten join cannot cross tenants. Nothing ever wrote it. Every row
 * created since carried NULL, so `flowise doctor` reported a tenancy FAILURE on any instance where
 * content existed — which is every real instance — and exited 1. A health gate that always fails is
 * not a health gate.
 *
 * The column being unwritten was never a live breach: no query reads it, and `workspaceId` (which
 * IS written) is what enforces isolation today. But §3a's safety net does not exist until the value
 * is actually there, and an operator cannot tell a genuine cross-tenant row from an unwritten one
 * while every row is NULL.
 *
 * Resolved from the workspace rather than taken from the request: `req.user.activeOrganizationId`
 * is client-influenced only through the session, but the workspace→organization mapping is the
 * authoritative relationship, and reading it here means the two can never disagree.
 *
 * Returns null rather than throwing when the workspace cannot be resolved. A missing tenant key is
 * the status quo and is detected by `doctor`; failing the write would turn a diagnostic gap into an
 * outage.
 */
export const resolveOrganizationIdForWorkspace = async (workspaceId?: string | null): Promise<string | null> => {
    if (!workspaceId) return null
    try {
        // Required lazily to avoid a cycle: this module is imported by services that the app server
        // itself pulls in during construction.
        const { getRunningExpressApp } = require('../../utils/getRunningExpressApp')
        const { Workspace } = require('../../database/entities/identity')
        const workspace = await getRunningExpressApp().AppDataSource.getRepository(Workspace).findOneBy({ id: workspaceId })
        return workspace?.organizationId ?? null
    } catch {
        return null
    }
}
