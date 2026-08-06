import { CookieOptions, NextFunction, Request, RequestHandler, Response, Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { StatusCodes } from 'http-status-codes'
import logger from '../../utils/logger'
import {
    getImplicitViewPermissions,
    PERMISSION_CATEGORIES,
    PERMISSION_CATALOG,
    PermissionCategory,
    PermissionDefinition
} from '../rbac/Permissions'
import { AuthenticatedUser } from '../rbac/types'
import { AuthContext, AuthService, LoginFailure } from '../services/AuthService'

/**
 * Identity — `/auth` router (SPEC-AUTH-RBAC.md §A.1, §A.14, §E).
 *
 * A STANDALONE module: it is not mounted by `packages/server/src/index.ts` yet, and it deliberately
 * imports nothing from the existing route tree. Cut-over is a separate change.
 *
 * Endpoints, and which of them the bootstrap must leave unauthenticated (spec §0.3 whitelists
 * `/api/v1/auth/resolve`, `/api/v1/auth/login` and `/api/v1/auth/refreshToken` by PREFIX):
 *
 *   POST /auth/login              unauthenticated
 *   POST /auth/resolve            unauthenticated
 *   POST /auth/refresh            unauthenticated (the refresh cookie is the credential)
 *   POST /auth/refreshToken       unauthenticated — the path the shipped client actually calls
 *   POST /auth/logout             unauthenticated by design (spec §E.5: it must work on a dead session)
 *   GET  /auth/permissions/:type  SESSION REQUIRED — not whitelisted (spec §0.3 note)
 */

/**
 * Session transport (spec §E.1: cookies, never a bearer header — nothing in `packages/ui/src/api/**`
 * constructs an `Authorization` header, and the shared client sets `withCredentials: true`).
 *
 * Two cookies, because the two halves have different lifetimes and different blast radii: the id
 * identifies the server-side session row, the secret proves ownership of it. Both are `HttpOnly` so
 * script cannot read them, and `SameSite=Lax` so a cross-site POST cannot carry them (§F-4 recommends
 * exactly this triple).
 *
 * `Path=/` rather than §F-4's suggested "refresh cookie scoped to the refresh route": a router does
 * not know its own mount point, and a cookie scoped to a path the deployment does not actually serve
 * silently stops refreshing. `IDENTITY_REFRESH_COOKIE_PATH` narrows it for a deployment that knows
 * its layout.
 */
export const SESSION_COOKIE = 'flowwiser.sid'
export const REFRESH_COOKIE = 'flowwiser.rt'

/** §0.5 / §A.14 — literals the client compares for equality (`packages/ui/src/store/constant.js:29-38`). */
const REFRESH_TOKEN_EXPIRED = 'Refresh Token Expired'
const INVALID_MISSING_TOKEN = 'Invalid or Missing token'
const UNAUTHORIZED = 'Unauthorized'

/** §A.14 — a 429 carrying this `type` renders inline on the sign-in form instead of navigating away. */
const AUTHENTICATION_RATE_LIMIT = 'authentication_rate_limit'

const isTrue = (value: string | undefined, fallback: boolean): boolean => (value === undefined ? fallback : value === 'true')

const cookieOptions = (env: NodeJS.ProcessEnv, path: string, maxAgeMs?: number): CookieOptions => ({
    httpOnly: true,
    // Secure by default anywhere that looks like production; a plain-HTTP lab deployment sets it to
    // 'false' explicitly, so the insecure case is always a deliberate act.
    secure: isTrue(env.IDENTITY_COOKIE_SECURE, env.NODE_ENV === 'production'),
    sameSite: 'lax',
    path,
    ...(maxAgeMs ? { maxAge: maxAgeMs } : {})
})

/**
 * Cookie reader that does not require `cookie-parser` to be mounted.
 *
 * `cookie-parser` IS a dependency and the bootstrap installs it, but this router has to work when it
 * is mounted on a bare test app too — and adding a runtime dependency is out of scope. Uses
 * `req.cookies` when the parser has already run, and falls back to the raw header.
 */
const readCookie = (req: Request, name: string): string | undefined => {
    const parsed = (req as Request & { cookies?: Record<string, string> }).cookies
    if (parsed && typeof parsed[name] === 'string') return parsed[name]

    const header = req.headers.cookie
    if (!header) return undefined
    for (const part of header.split(';')) {
        const index = part.indexOf('=')
        if (index < 0) continue
        if (part.slice(0, index).trim() !== name) continue
        try {
            return decodeURIComponent(part.slice(index + 1).trim())
        } catch {
            return part.slice(index + 1).trim()
        }
    }
    return undefined
}

const contextOf = (req: Request, route: string): AuthContext => ({
    ip: req.ip ?? null,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
    route
})

/**
 * The §F-7 body.
 *
 * `packages/ui/src/views/auth/signIn.jsx:90-92` GUARDS on `data.redirectUrl` but READS
 * `data.data.redirectUrl`. Only one can have been intended, so both are emitted; `redirectTo` is the
 * third name, used by the generic 401 handler (`ErrorContext.jsx:42-48`), and `error: 'unauthorized'`
 * is what selects the hard-navigation branch in `genericHelper.js:1071`. Identical to the shape
 * `rbac/PermissionCheck.ts` already emits, so the two 401s cannot drift.
 *
 * Emitted ONLY when the caller really must be sent elsewhere. An ordinary bad password must NOT
 * carry `redirectUrl`, or the shipped client replaces the error banner with a page navigation and the
 * user never sees why the login failed.
 */
export const redirectingUnauthorizedBody = (message: string, redirectUrl: string) => ({
    message,
    error: 'unauthorized',
    redirectUrl,
    redirectTo: redirectUrl,
    data: { redirectUrl }
})

// ── Permission catalog (§A.1 `GET /auth/permissions/:type`) ──────────────────────────────────

/**
 * Category headings are rendered by splitting camelCase
 * (`CreateEditRoleDialog.jsx:358-361`), which is why the catalog key must stay `documentStores`.
 * These are the labels used INSIDE each permission's `value`, not the headings themselves.
 */
const CATEGORY_LABELS: Record<PermissionCategory, string> = {
    apikeys: 'API Keys',
    assistants: 'Assistants',
    chatflows: 'Chatflows',
    agentflows: 'Agentflows',
    credentials: 'Credentials',
    tools: 'Tools',
    datasets: 'Datasets',
    documentStores: 'Document Stores',
    evaluations: 'Evaluations',
    evaluators: 'Evaluators',
    executions: 'Executions',
    variables: 'Variables',
    workspace: 'Workspaces',
    templates: 'Templates',
    logs: 'Logs',
    users: 'Users',
    roles: 'Roles',
    sso: 'SSO',
    loginActivity: 'Login Activity'
}

/** Verbs whose label is not simply the title-cased action. */
const ACTION_LABELS: Record<string, string> = {
    config: 'Configure',
    domains: 'Manage Allowed Domains',
    'add-loader': 'Add Loader To',
    'delete-loader': 'Delete Loader From',
    'preview-process': 'Preview & Process',
    'upsert-config': 'Configure Upsert For',
    'add-user': 'Add User To',
    'unlink-user': 'Unlink User From',
    reveal: 'Reveal Secret Values Of'
}

/** `templates` labels stand alone — its actions are not verbs applied to the noun (§B.5 exception). */
const TEMPLATE_LABELS: Record<string, string> = {
    marketplace: 'View Marketplace Templates',
    custom: 'View Custom Templates',
    'custom-delete': 'Delete Custom Templates',
    'custom-share': 'Share Custom Templates',
    flowexport: 'Export Flow As Template',
    toolexport: 'Export Tool As Template'
}

const titleCase = (action: string): string =>
    action
        .split('-')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')

const permissionLabel = (permission: PermissionDefinition): string => {
    if (permission.category === 'templates') return TEMPLATE_LABELS[permission.action] ?? titleCase(permission.action)
    if (permission.action === 'manage') return `Manage ${CATEGORY_LABELS[permission.category]}`
    return `${ACTION_LABELS[permission.action] ?? titleCase(permission.action)} ${CATEGORY_LABELS[permission.category]}`
}

/**
 * The catalog response (§A.1): category → descriptors.
 *
 * All three platform booleans are true. The client filters the catalog down to whichever ONE of
 * `isOpenSource` / `isEnterprise` / `isCloud` matches its platform type and deletes any category left
 * empty (`CreateEditRoleDialog.jsx:161-174`); Flow-Wiser is open source everywhere and gates nothing
 * behind a plan (REQUIREMENTS-AUTH-RBAC.md non-goals), so marking a permission as belonging to one
 * platform would hide it from a client that reported another and make the role editor lie about what
 * a role can hold.
 */
export const buildPermissionCatalog = (): Record<
    string,
    { key: string; value: string; isOpenSource: boolean; isEnterprise: boolean; isCloud: boolean }[]
> => {
    const catalog: Record<string, { key: string; value: string; isOpenSource: boolean; isEnterprise: boolean; isCloud: boolean }[]> = {}
    for (const category of PERMISSION_CATEGORIES) {
        catalog[category] = PERMISSION_CATALOG[category].map((permission) => ({
            key: permission.name,
            value: permissionLabel(permission),
            isOpenSource: true,
            isEnterprise: true,
            isCloud: true
        }))
    }
    return catalog
}

/** The only two values the client ever sends (§A.1: role editor and API-key dialog). */
const PERMISSION_CATALOG_TYPES = new Set(['ROLE', 'API_KEY'])

// ── Rate limiting (§A.14, §E.8) ──────────────────────────────────────────────────────────────

/**
 * Two limiters, composed in order: per IP, then per account.
 *
 * They answer different attacks and neither substitutes for the other. Per-IP bounds one host
 * spraying many accounts; per-account bounds a distributed attempt on ONE account, which no per-IP
 * limit can see. The account limiter runs second so a request that already tripped the IP limit does
 * not also consume the victim's account budget — otherwise an attacker could lock a known address out
 * of its own limiter for free.
 *
 * Defaults: 30 attempts / 15 min per IP, 10 / 15 min per account. `skipSuccessfulRequests` on the
 * account limiter means a user who signs in correctly is never spending their own budget.
 */
const buildLimiters = (env: NodeJS.ProcessEnv): { perIp: RequestHandler; perAccount: RequestHandler } => {
    const windowMs = Number.parseInt(env.IDENTITY_LOGIN_RATE_WINDOW_MS ?? '', 10) || 15 * 60 * 1000
    const perIpMax = Number.parseInt(env.IDENTITY_LOGIN_RATE_MAX_PER_IP ?? '', 10) || 30
    const perAccountMax = Number.parseInt(env.IDENTITY_LOGIN_RATE_MAX_PER_ACCOUNT ?? '', 10) || 10

    // §A.14: "emit a Retry-After header on every 429", and the authentication class must carry
    // `type: 'authentication_rate_limit'` so the client shows a banner rather than navigating to
    // /rate-limited and losing what the user typed.
    const handler =
        (scope: 'ip' | 'account') =>
        (req: Request, res: Response): void => {
            const retryAfterSeconds = Math.ceil(windowMs / 1000)
            res.setHeader('Retry-After', String(retryAfterSeconds))
            logger.warn(`[auth] rate limit (${scope}) tripped for ${req.ip ?? 'unknown ip'}`)
            res.status(StatusCodes.TOO_MANY_REQUESTS).json({
                type: AUTHENTICATION_RATE_LIMIT,
                message: 'Too many sign-in attempts. Please wait and try again.',
                retryAfter: retryAfterSeconds
            })
        }

    return {
        perIp: rateLimit({
            windowMs,
            max: perIpMax,
            standardHeaders: true,
            legacyHeaders: false,
            handler: handler('ip')
        }),
        perAccount: rateLimit({
            windowMs,
            max: perAccountMax,
            standardHeaders: false,
            legacyHeaders: false,
            skipSuccessfulRequests: true,
            // Keyed on the address as ATTEMPTED, normalised the same way AuthService normalises it,
            // so `Admin@x.com` and `admin@x.com` cannot be used to double the budget. Falls back to
            // the IP so a body-less flood is still bounded.
            keyGenerator: (req: Request): string => {
                const email = (req.body as { email?: unknown } | undefined)?.email
                return typeof email === 'string' && email.trim() ? `account:${email.trim().toLowerCase()}` : `ip:${req.ip ?? 'unknown'}`
            },
            handler: handler('account')
        })
    }
}

export interface AuthRouterOptions {
    authService?: AuthService
    env?: NodeJS.ProcessEnv
}

export const createAuthRouter = (options: AuthRouterOptions = {}): Router => {
    const env = options.env ?? process.env
    const auth = options.authService ?? new AuthService({ env })
    const router = Router()
    const { perIp, perAccount } = buildLimiters(env)

    const sessionCookiePath = env.IDENTITY_COOKIE_PATH || '/'
    const refreshCookiePath = env.IDENTITY_REFRESH_COOKIE_PATH || sessionCookiePath

    const setSessionCookies = (res: Response, sessionId: string, refreshSecret: string, expiresDate: Date): void => {
        const maxAgeMs = Math.max(expiresDate.getTime() - Date.now(), 0)
        res.cookie(SESSION_COOKIE, sessionId, cookieOptions(env, sessionCookiePath, maxAgeMs))
        res.cookie(REFRESH_COOKIE, refreshSecret, cookieOptions(env, refreshCookiePath, maxAgeMs))
    }

    const clearSessionCookies = (res: Response): void => {
        res.clearCookie(SESSION_COOKIE, cookieOptions(env, sessionCookiePath))
        res.clearCookie(REFRESH_COOKIE, cookieOptions(env, refreshCookiePath))
    }

    /**
     * Session gate for the endpoints spec §0.3 does NOT whitelist.
     *
     * Provisional and local by design: the global `verifyToken` equivalent lands with the cut-over,
     * and this router must not depend on middleware that does not exist yet. It denies with the
     * literal the client tests for (`ErrorContext.jsx:38`), which produces a clean logout rather than
     * a silent failure.
     */
    const requireSession: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
        void (async () => {
            const principal = await auth.authenticate(readCookie(req, SESSION_COOKIE), readCookie(req, REFRESH_COOKIE))
            if (!principal) {
                res.status(StatusCodes.UNAUTHORIZED).json({ message: INVALID_MISSING_TOKEN, error: 'unauthorized' })
                return
            }
            // Same property name the RBAC middleware reads off the request (§C.2). The double cast
            // is the write-side equivalent of the narrowing `PermissionCheck.ts` does on read: the
            // ambient `Request['user']` comes from passport's declaration merge, and assigning
            // through it would require augmenting a global type this module has no business owning
            // (the Apache-2.0 bootstrap uses a `@ts-ignore` at the same spot, `index.ts:279-290`).
            ;(req as unknown as { user?: AuthenticatedUser }).user = principal.user
            next()
        })().catch((error) => {
            // Fail closed: an exception in the gate denies, it does not fall through to the handler.
            logger.error(`❌ [auth] session gate failed closed: ${error instanceof Error ? error.message : String(error)}`)
            res.status(StatusCodes.UNAUTHORIZED).json({ message: UNAUTHORIZED, error: 'unauthorized' })
        })
    }

    /**
     * `POST /auth/login` — spec §A.1.
     *
     * 200 is the login payload; every failure is a 401 whose body is `{ message }` and nothing more,
     * because `signIn.jsx:90` treats any truthy `redirectUrl` as an instruction to navigate. The one
     * exception is {@link LoginFailure.SSO_REQUIRED}, which is the §F-7 case and does carry it.
     */
    router.post('/login', perIp, perAccount, (req: Request, res: Response, next: NextFunction) => {
        void (async () => {
            const body = (req.body ?? {}) as { email?: unknown; password?: unknown }
            const result = await auth.login(body.email, body.password, contextOf(req, 'POST /auth/login'))

            if (!result.ok) {
                if (result.failure === LoginFailure.SSO_REQUIRED && result.redirectUrl) {
                    res.status(StatusCodes.UNAUTHORIZED).json(redirectingUnauthorizedBody(result.message, result.redirectUrl))
                    return
                }
                // An internal failure is still an authentication failure to the caller: 401, generic
                // message, no detail. 500 would tell a prober that this address behaves differently.
                res.status(StatusCodes.UNAUTHORIZED).json({ message: result.message })
                return
            }

            setSessionCookies(res, result.session.sessionId, result.session.refreshSecret, result.session.expiresDate)
            res.status(StatusCodes.OK).json(result.payload)
        })().catch(next)
    })

    /**
     * `POST /auth/resolve` — spec §A.1. Called with an empty body from the `/login` resolver page,
     * which immediately does `window.location.href = data.redirectUrl`.
     */
    router.post('/resolve', perIp, (req: Request, res: Response, next: NextFunction) => {
        void (async () => {
            res.status(StatusCodes.OK).json(await auth.resolve())
        })().catch(next)
    })

    /**
     * `GET /auth/permissions/:type` — spec §A.1. The CATALOG (what permissions exist), never the
     * caller's own grants; those arrive on the login payload (§E.6).
     */
    router.get('/permissions/:type', requireSession, (req: Request, res: Response) => {
        const type = String(req.params.type ?? '').toUpperCase()
        if (!PERMISSION_CATALOG_TYPES.has(type)) {
            res.status(StatusCodes.BAD_REQUEST).json({ message: `Unsupported permission catalog type '${req.params.type}'` })
            return
        }
        // ROLE and API_KEY receive the same catalog: an API key's permission array is drawn from the
        // same vocabulary as a role's (spec §D.10), and the two dialogs render it identically. The
        // path parameter is validated rather than ignored so a typo fails loudly instead of silently
        // returning the full set.
        res.status(StatusCodes.OK).json(buildPermissionCatalog())
    })

    /**
     * `POST /auth/logout` — spec §E.5. Whitelisted, so it must succeed even on a dead session; the
     * cookies are cleared either way.
     */
    router.post('/logout', (req: Request, res: Response, next: NextFunction) => {
        void (async () => {
            const result = await auth.logout(readCookie(req, SESSION_COOKIE), contextOf(req, 'POST /auth/logout'))
            clearSessionCookies(res)
            res.status(StatusCodes.OK).json(result)
        })().catch(next)
    })

    /**
     * `POST /auth/refresh` and `POST /auth/refreshToken` — spec §E.4.
     *
     * Both paths, deliberately: `/refresh` is this project's name for it, and `/refreshToken` is the
     * literal path the shipped axios interceptor posts to (`packages/ui/src/api/client.js:24`), which
     * cannot be changed without touching the UI we are keeping verbatim.
     *
     * The response body must contain a truthy `id` — that is the client's ONLY success test — and
     * the rotated cookies are the actual result.
     */
    const refresh: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
        void (async () => {
            const result = await auth.refresh(
                readCookie(req, SESSION_COOKIE),
                readCookie(req, REFRESH_COOKIE),
                contextOf(req, 'POST /auth/refresh')
            )
            if (!result.ok) {
                clearSessionCookies(res)
                // No `retry: true` here: §E.4 warns there is no retry-loop guard in the client, so a
                // refresh that itself invited another refresh would recurse.
                res.status(StatusCodes.UNAUTHORIZED).json({ message: REFRESH_TOKEN_EXPIRED, reason: result.reason })
                return
            }
            setSessionCookies(res, result.sessionId, result.issued.refreshSecret, result.issued.expiresDate)
            res.status(StatusCodes.OK).json({ id: result.sessionId })
        })().catch(next)
    }
    router.post('/refresh', perIp, refresh)
    router.post('/refreshToken', perIp, refresh)

    return router
}

/**
 * Implicit-view coupling, re-exported for the role service.
 *
 * §B.6 rules 1 and 3 are enforced client-side and mirrored server-side; the role editor derives a
 * category's implicit view token as `${category}:view`, with `templates` as the sole exception. Kept
 * here so a future `/role` handler reaches for the same helper the catalog response was built from.
 */
export { getImplicitViewPermissions }

export default createAuthRouter
