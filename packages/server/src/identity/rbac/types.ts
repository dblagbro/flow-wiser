/**
 * Shapes the RBAC layer expects on the request.
 *
 * Derived from SPEC-AUTH-RBAC.md §C.2 and the Apache-2.0 construction site at
 * `packages/server/src/index.ts:280-290`, which is the only place in the Apache-2.0 tree
 * where `req.user` is built (the API-key authentication branch).
 */

/**
 * Feature flags (SPEC §B.4). A separate axis from permissions: they gate *availability*,
 * not *authority*, and are composed before the permission gate (§C.6). Values arrive as
 * either booleans or the strings 'true'/'false' — the client accepts both
 * (`packages/ui/src/routes/RequireAuth.jsx:23`), so the type must too.
 */
export type FeatureFlags = Record<string, string | boolean>

/**
 * The authenticated principal.
 *
 * Two authentication schemes populate the same shape (§C.2). The API-key branch sets every
 * field except `id`; the session branch additionally sets `id` — required by
 * `packages/server/src/controllers/chatflows/index.ts:245`. `id` is therefore
 * present-for-sessions / absent-for-API-keys and must stay optional.
 */
export interface AuthenticatedUser {
    /** Sessions only. Absent on the API-key branch — see §C.2. */
    id?: string

    /**
     * Flat array of `<category>:<action>` strings — not nested, not a bitmask (§C.2).
     * Established independently server-side (`controllers/chatflows/index.ts:80`) and
     * client-side (`packages/ui/src/hooks/useAuth.jsx:18`).
     *
     * These are the *effective* permissions for the user's ACTIVE workspace: the client is
     * re-issued this array on login, SSO-success and workspace-switch (§E.6), so the array
     * is always the grant set of the role held in `activeWorkspaceId`. The middleware
     * therefore never resolves a role itself — it reads what the auth layer scoped.
     */
    permissions?: string[]

    /** §B.4 / §C.6 — feature availability, evaluated by a different middleware. */
    features?: FeatureFlags

    /**
     * Total bypass of permission evaluation (§C.4 rule 1), mirrored client-side at
     * `packages/ui/src/hooks/useAuth.jsx:12`. This is the single bootstrap-owner escape
     * hatch permitted by REQUIREMENTS §4 ("no implicit super-role beyond one bootstrap
     * owner"); nothing else may short-circuit a check.
     */
    isOrganizationAdmin?: boolean

    /** Active workspace — the scope the `permissions` array belongs to (§C.2, §C.5). */
    activeWorkspaceId?: string
    activeWorkspace?: string

    /** Active organization and its billing identifiers (`index.ts:283-286`). */
    activeOrganizationId?: string
    activeOrganizationSubscriptionId?: string
    activeOrganizationCustomerId?: string
    activeOrganizationProductId?: string
}

/** How a permission expression is satisfied. There is no all-of form in the route tree (§B.1). */
export type PermissionMode = 'single' | 'any'

/** Why the RBAC layer decided what it decided. Recorded verbatim in the audit event. */
export type PermissionDecisionReason =
    /** The registered permission expression is invalid — unknown token, empty, or malformed. */
    | 'configuration-error'
    /** No `req.user` — authentication has not happened (§C.3 → 401). */
    | 'unauthenticated'
    /** `req.user` exists but carries no usable permission array — fail closed. */
    | 'indeterminate-authority'
    /** `req.user` carries no active workspace, so the grant set has no scope — fail closed. */
    | 'no-active-workspace'
    /** `isOrganizationAdmin` bypass (§C.4 rule 1). */
    | 'organization-admin'
    /** At least one required token is held. */
    | 'permission-granted'
    /** None of the required tokens is held (§C.3 → 403). */
    | 'permission-not-granted'
    /** The check threw. Denied rather than passed through — REQUIREMENTS §4 "fail closed". */
    | 'internal-error'

/** A structured RBAC audit event — REQUIREMENTS §4 ("who, what, allowed/denied, when"). */
export interface PermissionAuditEvent {
    event: 'rbac.permission_check'
    /** ISO-8601 UTC. */
    timestamp: string
    decision: 'allow' | 'deny'
    reason: PermissionDecisionReason
    /** Subject: user id for sessions, or the api-key principal which carries no id (§C.2). */
    subjectType: 'user' | 'api-key' | 'anonymous'
    subjectId: string | null
    /** The expression as written at the call site, e.g. 'chatflows:create,agentflows:create'. */
    permission: string
    mode: PermissionMode
    /** Tokens that were actually required, after parsing. */
    required: string[]
    /** Tokens the subject holds that intersect `required` — empty on deny. */
    matched: string[]
    route: string
    workspaceId: string | null
    organizationId: string | null
    /** HTTP status the request was terminated with, or null when the check passed. */
    status: number | null
}
