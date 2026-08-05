import { NextFunction, Request, RequestHandler, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { GeneralErrorMessage } from '../../utils/constants'
import logger, { auditLogger } from '../../utils/logger'
import { ALL_PERMISSIONS, isKnownPermission, parsePermissionExpression } from './Permissions'
import { AuthenticatedUser, PermissionAuditEvent, PermissionDecisionReason, PermissionMode } from './types'

/**
 * Permission enforcement middleware.
 *
 * Signatures are fixed by the 120 existing call sites in `packages/server/src/routes/**`
 * (SPEC-AUTH-RBAC.md §C.1): both are *factories* returning a reusable `RequestHandler`.
 * `packages/server/src/routes/webhook-listener/index.ts:7` binds the result to a const and
 * reuses it across three routes, so the returned handler must be stateless per request.
 *
 * Behaviour beyond the observed contract is set by REQUIREMENTS-AUTH-RBAC.md §4:
 * deny-by-default, workspace scoping, structured audit events, fail closed.
 */

/**
 * §F-7 — the shipped client *guards* on `error.response.data.redirectUrl` but *reads*
 * `error.response.data.data.redirectUrl` (`packages/ui/src/views/auth/signIn.jsx:90-92`).
 * Only one can be the intended contract, so we emit both, plus `redirectTo` for the generic
 * 401 handler (`packages/ui/src/store/context/ErrorContext.jsx:42-48`). Overridable so a
 * deployment mounted under a path prefix can point at its real login route.
 */
const UNAUTHENTICATED_REDIRECT_URL = process.env.RBAC_UNAUTHENTICATED_REDIRECT_URL || '/login'

/**
 * REQUIREMENTS §4 requires an audit event for every decision. Denials are always recorded,
 * on both the audit stream and the server log. Allow events go to the audit stream only;
 * set RBAC_AUDIT_ALLOW_DECISIONS=false to suppress them on very high-traffic deployments
 * (denials can never be suppressed).
 */
const AUDIT_ALLOW_DECISIONS = process.env.RBAC_AUDIT_ALLOW_DECISIONS !== 'false'

interface Decision {
    allowed: boolean
    reason: PermissionDecisionReason
    matched: string[]
    /** HTTP status to terminate with when `allowed` is false. */
    status: number
}

const allow = (reason: PermissionDecisionReason, matched: string[] = []): Decision => ({
    allowed: true,
    reason,
    matched,
    status: StatusCodes.OK
})

const deny = (reason: PermissionDecisionReason, status: number): Decision => ({
    allowed: false,
    reason,
    matched: [],
    status
})

/** Route identity for the audit record. `originalUrl` is avoided: it carries the query string. */
const describeRoute = (req: Request): string => `${req.method} ${req.baseUrl || ''}${req.path || ''}`

const getUser = (req: Request): AuthenticatedUser | undefined => {
    // The Apache-2.0 bootstrap assigns `req.user` through a `@ts-ignore`
    // (`packages/server/src/index.ts:279-290`) because the ambient Express type comes from
    // passport. Narrow locally rather than augmenting the global type, so this module stays
    // independent of whatever the auth layer eventually declares.
    return (req as Request & { user?: AuthenticatedUser }).user
}

const emitAudit = (event: PermissionAuditEvent): void => {
    if (event.decision === 'deny') {
        auditLogger.warn(event)
        // Deny-by-default only helps if misconfiguration is visible. Configuration errors and
        // indeterminate authority are operator problems, not user problems — surface them at
        // `error` on the main log; ordinary "user lacks the permission" denials at `warn`.
        const loud =
            event.reason === 'configuration-error' || event.reason === 'indeterminate-authority' || event.reason === 'internal-error'
        const line =
            `[rbac] DENY ${event.route} permission='${event.permission}' reason=${event.reason} ` +
            `subject=${event.subjectType}:${event.subjectId ?? 'none'} workspace=${event.workspaceId ?? 'none'} status=${event.status}`
        if (loud) logger.error(line)
        else logger.warn(line)
        return
    }
    if (AUDIT_ALLOW_DECISIONS) auditLogger.info(event)
}

const audit = (
    req: Request,
    user: AuthenticatedUser | undefined,
    expression: string,
    mode: PermissionMode,
    required: string[],
    decision: Decision
): void => {
    emitAudit({
        event: 'rbac.permission_check',
        timestamp: new Date().toISOString(),
        decision: decision.allowed ? 'allow' : 'deny',
        reason: decision.reason,
        // §C.2 — the session branch supplies `req.user.id`; the API-key branch does not. The
        // absence of an id is therefore itself identifying information, not missing data.
        subjectType: user ? (user.id ? 'user' : 'api-key') : 'anonymous',
        subjectId: user?.id ?? null,
        permission: expression,
        mode,
        required,
        matched: decision.matched,
        route: describeRoute(req),
        workspaceId: user?.activeWorkspaceId ?? null,
        organizationId: user?.activeOrganizationId ?? null,
        status: decision.allowed ? null : decision.status
    })
}

const respondDenied = (res: Response, decision: Decision): void => {
    if (decision.status === StatusCodes.UNAUTHORIZED) {
        // §C.3 / §A.14 — the client routes on the 401/403 distinction: 401 logs the user out
        // and sends them to /login, 403 keeps the session and shows /unauthorized. The
        // `message` literal must match `GeneralErrorMessage.UNAUTHORIZED`
        // (`packages/server/src/utils/constants.ts:71`) and `error: 'unauthorized'` drives the
        // redirect branch in `packages/ui/src/utils/genericHelper.js:1071`.
        res.status(StatusCodes.UNAUTHORIZED).json({
            message: GeneralErrorMessage.UNAUTHORIZED,
            error: 'unauthorized',
            redirectUrl: UNAUTHENTICATED_REDIRECT_URL, // signIn.jsx:90 guards on this
            redirectTo: UNAUTHENTICATED_REDIRECT_URL, // ErrorContext.jsx:42-48 reads this
            data: { redirectUrl: UNAUTHENTICATED_REDIRECT_URL } // signIn.jsx:92 reads this — §F-7
        })
        return
    }
    // §C.3 — 403 for authenticated-but-unauthorised. `message` is rendered by the UI's generic
    // error renderer, which reads `response.data.message` for object bodies.
    res.status(StatusCodes.FORBIDDEN).json({ message: GeneralErrorMessage.FORBIDDEN })
}

/**
 * The matching algorithm. Semantically identical to the client mirror
 * `packages/ui/src/hooks/useAuth.jsx:11-21` — any-of over a flat string array — with the
 * open-source blanket grant (`useAuth.jsx:12`) deliberately NOT reproduced: REQUIREMENTS §4
 * makes RBAC real on every deployment, and Flow-Wiser is open source everywhere, so honouring
 * that branch server-side would disable authorisation entirely.
 */
const evaluate = (user: AuthenticatedUser | undefined, required: string[]): Decision => {
    if (!user) return deny('unauthenticated', StatusCodes.UNAUTHORIZED)

    // §C.4 rule 1 — total bypass, the single bootstrap-owner escape hatch allowed by
    // REQUIREMENTS §4. Checked before the shape validation below so an owner is never locked
    // out by a malformed grant set.
    if (user.isOrganizationAdmin === true) return allow('organization-admin')

    // Fail closed (REQUIREMENTS §4): if we cannot read a well-formed grant set we have no
    // authority to evaluate against, so we deny rather than treat it as "no permissions".
    if (!Array.isArray(user.permissions)) return deny('indeterminate-authority', StatusCodes.FORBIDDEN)

    // §E.6 — `permissions` is the grant set of the role held in the ACTIVE workspace; it is
    // re-issued on login, SSO-success and workspace-switch. Without an active workspace the
    // array has no scope we can trust, so it cannot authorise anything.
    if (!user.activeWorkspaceId) return deny('no-active-workspace', StatusCodes.FORBIDDEN)

    const held = new Set(user.permissions.filter((p): p is string => typeof p === 'string'))
    const matched = required.filter((p) => held.has(p))
    return matched.length > 0 ? allow('permission-granted', matched) : deny('permission-not-granted', StatusCodes.FORBIDDEN)
}

/**
 * Builds the handler. A configuration error (unknown token, empty expression, wrong shape)
 * yields a handler that denies unconditionally: REQUIREMENTS §4 — an unknown permission is
 * denied, never silently allowed, and the misconfiguration is logged loudly at both
 * registration time and request time.
 */
const buildHandler = (expression: string, mode: PermissionMode): RequestHandler => {
    const configErrors: string[] = []

    if (typeof expression !== 'string' || expression.trim().length === 0) {
        // Mirrors `useAuth.jsx:15` (`if (!permissionId) return false`) — an empty expression
        // authorises nothing.
        configErrors.push('permission expression is empty')
    }

    const required = typeof expression === 'string' ? parsePermissionExpression(expression) : []

    if (mode === 'single' && required.length > 1) {
        // §C.1 — no Apache-2.0 call site passes a comma to `checkPermission`. Rather than
        // guessing all-of or any-of, reject: an ambiguous gate must not be a permissive one.
        configErrors.push(`checkPermission received ${required.length} tokens; use checkAnyPermission for any-of`)
    }

    for (const token of required) {
        if (!isKnownPermission(token)) configErrors.push(`unknown permission '${token}' (not in the catalog of ${ALL_PERMISSIONS.size})`)
    }

    if (configErrors.length > 0) {
        // Loud at registration: this fires once at boot, when someone can still act on it.
        logger.error(
            `❌ [rbac]: refusing to register permission gate '${expression}' — ${configErrors.join('; ')}. ` +
                `All requests to this route will be denied (deny-by-default).`
        )
    }

    const misconfigured = configErrors.length > 0

    return (req: Request, res: Response, next: NextFunction): void => {
        let user: AuthenticatedUser | undefined
        try {
            user = getUser(req)
            const decision = misconfigured ? deny('configuration-error', StatusCodes.FORBIDDEN) : evaluate(user, required)
            audit(req, user, expression, mode, required, decision)
            if (decision.allowed) {
                next()
                return
            }
            respondDenied(res, decision)
        } catch (error) {
            // Fail closed (REQUIREMENTS §4): an exception inside the permission subsystem means
            // authority is indeterminate. Deny; never fall through to `next()`.
            const decision = deny('internal-error', StatusCodes.FORBIDDEN)
            logger.error(
                `❌ [rbac]: permission check '${expression}' threw; denying. ${error instanceof Error ? error.stack : String(error)}`
            )
            try {
                audit(req, user, expression, mode, required, decision)
            } catch {
                // Auditing must never turn a deny into a crash.
            }
            respondDenied(res, decision)
        }
    }
}

/**
 * Requires the single named permission.
 *
 * `router.get('/', checkPermission('apikeys:view'), controller)` —
 * `packages/server/src/routes/apikey/index.ts:10`.
 */
export const checkPermission = (permission: string): RequestHandler => buildHandler(permission, 'single')

/**
 * Requires at least one of the comma-separated permissions (§B.1, §C.1). Called with no
 * whitespace between tokens, and legitimately called with a *single* token — e.g.
 * `checkAnyPermission('logs:view')` (`packages/server/src/routes/log/index.ts:7`) — in which
 * case it must behave identically to `checkPermission`.
 *
 * There is no `checkAllPermissions`: every multi-token check in the route tree is any-of.
 */
export const checkAnyPermission = (permissions: string): RequestHandler => buildHandler(permissions, 'any')

/**
 * The same decision, as a pure predicate, for the post-middleware narrowing described in
 * §C.4 — any-of middleware is deliberately permissive and controllers then narrow by
 * resource type (e.g. `controllers/chatflows/index.ts:69-84`). Exposed so controllers do not
 * hand-roll `permissions.includes(...)` and drift from the middleware's semantics.
 */
export const userHasAnyPermission = (user: AuthenticatedUser | undefined, expression: string): boolean => {
    const required = parsePermissionExpression(expression).filter(isKnownPermission)
    if (required.length === 0) return false
    return evaluate(user, required).allowed
}

export default { checkPermission, checkAnyPermission, userHasAnyPermission }
