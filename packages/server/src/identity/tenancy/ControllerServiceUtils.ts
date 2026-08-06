import { Request } from 'express'

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
export const getWorkspaceSearchOptions = (workspaceId?: string | null): WorkspaceSearchOptions =>
    workspaceId ? { workspaceId } : {}

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
