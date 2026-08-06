/**
 * The permission catalog.
 *
 * Every entry below was recovered by scraping `checkPermission(...)` /
 * `checkAnyPermission(...)` string literals out of `packages/server/src/routes/**` (Apache-2.0)
 * and the permission literals used by the Apache-2.0 client in `packages/ui/src/**`. The
 * `routes` field on each entry records the route module the literal was found in, so the
 * provenance of every token is checkable with a grep.
 *
 * Counts (SPEC-AUTH-RBAC.md §B): 82 distinct SCRAPED permissions — 61 enforced by a route call
 * site, 21 appearing only in the client with no Apache-2.0 route enforcement (§B.3). The scrape
 * reproduces that split exactly. Unenforced entries are marked `enforcement: 'unenforced'`:
 * they are real permissions the role editor can grant, but nothing in the Apache-2.0 route
 * tree checks them, so an implementer must supply the enforcement when the corresponding
 * endpoints are written.
 *
 * On top of the 82 scraped tokens the catalog carries the NET-NEW permissions Flow-Wiser adds of
 * its own accord — see {@link NET_NEW_PERMISSIONS}. They are kept separate from the scrape so the
 * provenance claim above stays literally true and checkable: every token NOT in that set can still
 * be traced to an Apache-2.0 call site.
 *
 * This catalog is the sole authority for what a permission string may be. Anything not in it
 * is denied — see PermissionCheck.ts and REQUIREMENTS-AUTH-RBAC.md §4 ("Deny-by-default:
 * unknown permission → denied").
 */

/**
 * SPEC §B.5 — the catalog must group under exactly these keys, because each category's
 * implicit-view permission is derived as `${category}:view` (with `templates` as the sole
 * exception, handled in `getImplicitViewPermissions`).
 */
export const PERMISSION_CATEGORIES = [
    'apikeys',
    'assistants',
    'chatflows',
    'agentflows',
    'credentials',
    'tools',
    'datasets',
    'documentStores',
    'evaluations',
    'evaluators',
    'executions',
    'variables',
    'workspace',
    'templates',
    'logs',
    'users',
    'roles',
    'sso',
    'loginActivity'
] as const

export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number]

/**
 * `route`      — at least one `checkPermission`/`checkAnyPermission` call site enforces it.
 * `unenforced` — no Apache-2.0 route enforcement exists yet (SPEC §B.3). Still a valid,
 *                grantable permission; it simply has no gate wired to it.
 */
export type PermissionEnforcement = 'route' | 'unenforced'

export interface PermissionDefinition {
    /** The wire form, `<category>:<action>`. */
    readonly name: string
    readonly category: PermissionCategory
    readonly action: string
    readonly enforcement: PermissionEnforcement
    /** Route modules under `packages/server/src/routes/` where the literal appears. */
    readonly routes: readonly string[]
    /**
     * SPEC §B.2 — flagged in the role editor as an administrative privilege that performs
     * workspace-level actions with implicit access to all contained resources
     * (`packages/ui/src/views/roles/CreateEditRoleDialog.jsx:388-395`).
     */
    readonly administrative?: boolean
}

/** `[action, routeModules]`. An empty route list means the permission is unenforced (§B.3). */
type PermissionSeed = readonly [action: string, routes: readonly string[]]

const SEEDS: Readonly<Record<PermissionCategory, readonly PermissionSeed[]>> = {
    apikeys: [
        ['view', ['apikey']],
        ['create', ['apikey']],
        ['update', ['apikey']],
        ['delete', ['apikey']]
    ],
    assistants: [
        ['view', ['assistants', 'openai-assistants', 'openai-assistants-vector-store']],
        ['create', ['assistants', 'openai-assistants-vector-store']],
        ['update', ['assistants', 'openai-assistants-vector-store']],
        // Also appears as one alternative on DELETE /chatflows — §B.2 (assistants block).
        ['delete', ['assistants', 'openai-assistants-vector-store', 'chatflows']]
    ],
    chatflows: [
        ['view', ['chatflows', 'openai-realtime', 'node-load-methods']],
        ['create', ['chatflows', 'node-custom-functions', 'openai-realtime', 'webhook-listener', 'node-load-methods']],
        ['update', ['chatflows', 'node-custom-functions', 'openai-realtime', 'webhook-listener', 'node-load-methods']],
        ['delete', ['chatflows', 'openai-realtime', 'node-load-methods']],
        ['config', ['mcp-server']],
        // §B.3 — client literals only; no route call site.
        ['duplicate', []],
        ['import', []],
        ['export', []],
        ['domains', []]
    ],
    agentflows: [
        // §C.4 rule 2: agentflows:* governs both AGENTFLOW and MULTIAGENT. There is no
        // separate multi-agent permission.
        ['view', ['chatflows', 'node-load-methods']],
        ['create', ['chatflows', 'node-custom-functions', 'webhook-listener', 'node-load-methods']],
        ['update', ['chatflows', 'node-custom-functions', 'webhook-listener', 'node-load-methods']],
        ['delete', ['chatflows', 'node-load-methods']],
        ['config', ['mcp-server']],
        ['duplicate', []],
        ['import', []],
        ['export', []],
        ['domains', []]
    ],
    credentials: [
        // §B.2: deliberate asymmetry — reading a *specific* credential and revealing its
        // secret is gated on create/update, not on credentials:view.
        ['view', ['credentials']],
        ['create', ['credentials']],
        ['update', ['credentials']],
        ['delete', ['credentials']],
        ['share', []],
        // NET-NEW — not scraped, see NET_NEW_PERMISSIONS below.
        ['reveal', []]
    ],
    tools: [
        ['view', ['tools', 'custom-mcp-servers']],
        ['create', ['tools', 'custom-mcp-servers']],
        ['update', ['tools', 'custom-mcp-servers']],
        ['delete', ['tools', 'custom-mcp-servers']],
        ['export', []]
    ],
    datasets: [
        ['view', ['dataset']],
        ['create', ['dataset']],
        ['update', ['dataset']],
        ['delete', ['dataset']]
    ],
    documentStores: [
        ['view', ['documentstore', 'node-load-methods']],
        ['create', ['documentstore', 'node-load-methods']],
        ['update', ['documentstore', 'node-load-methods']],
        ['delete', ['documentstore']],
        ['add-loader', ['documentstore', 'node-load-methods']],
        ['delete-loader', ['documentstore']],
        ['preview-process', ['documentstore']],
        ['upsert-config', ['documentstore']]
    ],
    evaluations: [
        // §B.2: `evaluations:update` does not exist — view/create/delete/run only.
        ['view', ['evaluations']],
        ['create', ['evaluations']],
        ['delete', ['evaluations']],
        ['run', ['evaluations']]
    ],
    evaluators: [
        ['view', ['evaluator']],
        ['create', ['evaluator']],
        ['update', ['evaluator']],
        ['delete', ['evaluator']]
    ],
    executions: [
        ['view', ['executions']],
        ['update', ['executions']],
        ['delete', ['executions', 'chatflows']]
    ],
    variables: [
        ['view', ['variables']],
        ['create', ['variables']],
        ['update', ['variables']],
        ['delete', ['variables']]
    ],
    workspace: [
        ['export', ['export-import']],
        ['import', ['export-import']],
        // §B.3 — the workspace management surface lives outside the Apache-2.0 route tree.
        ['view', []],
        ['create', []],
        ['update', []],
        ['delete', []],
        ['add-user', []],
        ['unlink-user', []]
    ],
    templates: [
        ['marketplace', ['marketplaces']],
        ['custom', ['marketplaces']],
        ['custom-delete', ['marketplaces']],
        ['flowexport', ['marketplaces']],
        ['toolexport', ['marketplaces']],
        ['custom-share', []]
    ],
    logs: [['view', ['log']]],
    users: [['manage', []]],
    roles: [['manage', []]],
    sso: [['manage', []]],
    loginActivity: [['view', []]]
}

/**
 * §B.2 — `workspace:export` / `workspace:import` bypass per-resource checks within the
 * workspace by design ("Performs workspace-level actions with implicit access to all
 * contained resources"). Exported so callers can apply extra scrutiny; the middleware does
 * NOT grant anything on the strength of this flag.
 */
const ADMINISTRATIVE = new Set(['workspace:export', 'workspace:import'])

/**
 * Permissions Flow-Wiser adds that no Apache-2.0 source contains.
 *
 * `credentials:reveal` — REQUIREMENTS-MIGRATION.md §3 "The credential-value split — a distinction
 * upstream does not make". Upstream conflates managing a credential with reading it, which is why
 * one compromised account yields every API key at once. Splitting them needs a token that upstream
 * has no equivalent of, so it cannot come from the scrape. Held by `admin` and `super-admin` only
 * (REQUIREMENTS-TENANCY-ACCESS.md §2), never implied by any other grant, and every use is audited
 * (`AuditService.credentialRevealed`).
 *
 * It is `unenforced` for now in the same sense as the other 21: no route gates it yet, because the
 * reveal endpoint does not exist yet. It is in the catalog so that when that endpoint is written the
 * gate is already a known token — an unknown one would be denied by deny-by-default, which fails
 * closed but silently, and a permission the role editor cannot show is a permission nobody grants.
 */
export const NET_NEW_PERMISSIONS: ReadonlySet<string> = new Set(['credentials:reveal'])

const buildCatalog = (): Record<PermissionCategory, readonly PermissionDefinition[]> => {
    const catalog = {} as Record<PermissionCategory, readonly PermissionDefinition[]>
    for (const category of PERMISSION_CATEGORIES) {
        catalog[category] = SEEDS[category].map(([action, routes]) => {
            const name = `${category}:${action}`
            const definition: PermissionDefinition = {
                name,
                category,
                action,
                enforcement: routes.length > 0 ? 'route' : 'unenforced',
                routes
            }
            return ADMINISTRATIVE.has(name) ? { ...definition, administrative: true } : definition
        })
    }
    return catalog
}

/** The typed catalog, grouped by category (§B.5). */
export const PERMISSION_CATALOG: Readonly<Record<PermissionCategory, readonly PermissionDefinition[]>> = buildCatalog()

/** Flat list, in catalog order. */
export const PERMISSION_DEFINITIONS: readonly PermissionDefinition[] = PERMISSION_CATEGORIES.flatMap(
    (category) => PERMISSION_CATALOG[category]
)

const BY_NAME: ReadonlyMap<string, PermissionDefinition> = new Map(PERMISSION_DEFINITIONS.map((p) => [p.name, p]))

/**
 * The flat validation set. Membership here is the *only* thing that makes a permission
 * string legal — REQUIREMENTS §4 deny-by-default.
 */
export const ALL_PERMISSIONS: ReadonlySet<string> = new Set(BY_NAME.keys())

/** The 61 permissions with a live route gate. */
export const ROUTE_ENFORCED_PERMISSIONS: ReadonlySet<string> = new Set(
    PERMISSION_DEFINITIONS.filter((p) => p.enforcement === 'route').map((p) => p.name)
)

/** Permissions with no Apache-2.0 route gate yet — the 21 of §B.3 plus the net-new tokens above. */
export const UNENFORCED_PERMISSIONS: ReadonlySet<string> = new Set(
    PERMISSION_DEFINITIONS.filter((p) => p.enforcement === 'unenforced').map((p) => p.name)
)

export const ADMINISTRATIVE_PERMISSIONS: ReadonlySet<string> = new Set(
    PERMISSION_DEFINITIONS.filter((p) => p.administrative).map((p) => p.name)
)

/** True when `permission` is a registered permission string. Unknown ⇒ false ⇒ denied. */
export const isKnownPermission = (permission: string): boolean => ALL_PERMISSIONS.has(permission)

export const getPermission = (permission: string): PermissionDefinition | undefined => BY_NAME.get(permission)

/**
 * §B.5 — the implicit-view permission(s) of a category. `templates` is the sole exception:
 * its implicit-view pair is `templates:marketplace` + `templates:custom`
 * (`packages/ui/src/views/roles/CreateEditRoleDialog.jsx:69-73`). Categories whose only
 * permission is not a view (e.g. `users:manage`) correctly yield an empty list.
 */
export const getImplicitViewPermissions = (category: PermissionCategory): string[] => {
    if (category === 'templates') return ['templates:marketplace', 'templates:custom'].filter((p) => ALL_PERMISSIONS.has(p))
    const view = `${category}:view`
    return ALL_PERMISSIONS.has(view) ? [view] : []
}

/**
 * §B.6 rules 1 and 3, mirrored server-side: granting any non-view permission in a category
 * implies that category's view permission(s). The client enforces this in the role editor;
 * mirroring it here stops a hand-crafted API request from producing a role the UI cannot
 * represent. Returns a new array; input order is preserved and implied tokens are appended.
 */
export const withImpliedViewPermissions = (permissions: readonly string[]): string[] => {
    const result = permissions.filter((p) => ALL_PERMISSIONS.has(p))
    const seen = new Set(result)
    for (const name of result.slice()) {
        const definition = BY_NAME.get(name)
        if (!definition) continue
        for (const implied of getImplicitViewPermissions(definition.category)) {
            if (implied === name || seen.has(implied)) continue
            seen.add(implied)
            result.push(implied)
        }
    }
    return result
}

/**
 * Parses a call-site expression into its tokens. `checkAnyPermission` receives
 * comma-separated tokens with no whitespace (§C.1), but we trim defensively rather than
 * letting a stray space silently become an unknown — and therefore denied — token.
 */
export const parsePermissionExpression = (expression: string): string[] =>
    expression
        .split(',')
        .map((token) => token.trim())
        .filter((token) => token.length > 0)
