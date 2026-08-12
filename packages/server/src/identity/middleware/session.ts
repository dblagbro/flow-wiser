import { Application, NextFunction, Request, RequestHandler, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import logger from '../../utils/logger'
import { ErrorMessage, LoggedInUser } from '../Interface'
import { AuthService } from '../services/AuthService'
import { REFRESH_COOKIE, SESSION_COOKIE } from '../routes/auth'

/**
 * Session authentication middleware — the Apache-2.0 replacement for the passport/JWT middleware
 * the server bootstrap imports.
 *
 * CLEAN-ROOM PROVENANCE. Three symbols, and the contract of each was fixed entirely by its
 * Apache-2.0 call site in `packages/server/src/index.ts`:
 *
 *   initializeJwtCookieMiddleware(app, identityManager)   index.ts:228
 *       `await`ed, inside `App.config()`, AFTER `cookieParser()` and BEFORE the whitelist/API-key
 *       middleware. Return value discarded. So: async, mounts middleware on the app, and must NOT
 *       terminate requests — the very next middleware still has to see anonymous traffic in order
 *       to route it to the whitelist or the API-key branch.
 *
 *   verifyToken(req, res, next)                           index.ts:240
 *       Called DIRECTLY (not mounted) for requests carrying `x-request-from: internal`, which is
 *       the header the shipped UI client sets on every call (`packages/ui/src/api/client.js:9`).
 *       This is therefore the gate for the entire browser-facing API: it must 401 anonymous
 *       callers rather than fall through.
 *
 *   verifyTokenForBullMQDashboard                         index.ts:350
 *       Mounted as middleware on `/admin/queues`, between a rate limiter and the bull-board router.
 *       A `RequestHandler`, not a factory.
 *
 * ── Why "JwtCookie" keeps its name but not its mechanism ─────────────────────────────────────
 *
 * The name is retained so the bootstrap needs an import-path change and nothing else. What it
 * mounts is a SERVER-SIDE SESSION lookup, not a JWT verification: SPEC-AUTH-RBAC §E.1 chose an
 * opaque session id plus a hashed refresh secret over a self-describing token, because a JWT
 * cannot be revoked before it expires and REQUIREMENTS §4 wants a session that dies when it is
 * told to. `AuthService.authenticate` re-reads the row and re-resolves permissions on every
 * request, so a role edit or a revocation takes effect immediately (§E.6).
 */

/** Header the shipped UI client stamps on every request (`packages/ui/src/api/client.js:9`). */
export const INTERNAL_REQUEST_HEADER = 'x-request-from'

/**
 * Paths that stay reachable while `mustChangePassword` is set (MIGRATION §6).
 *
 * §6: "The flag blocks all authenticated routes except the change-password endpoint until
 * cleared." Read literally that is one path, but three more are required for the rule to be
 * survivable rather than a lockout:
 *
 *   /api/v1/account/reset-password   THE change-password endpoint. `packages/ui/src/api/
 *                                    account.api.js:9` is the only client call that sets a new
 *                                    password, and `views/auth/resetPassword.jsx:110` is the only
 *                                    screen that reaches it.
 *   /api/v1/auth/logout              a user who cannot proceed must still be able to leave.
 *   /api/v1/account/logout           the same endpoint under the name the client actually calls
 *                                    (`account.api.js:10`).
 *   /api/v1/auth/refreshToken        the axios interceptor refreshes on 401 (`client.js:24`);
 *                                    blocking it turns one 403 into a logout loop.
 *
 * Prefix-matched, consistent with how `WHITELIST_URLS` is applied in the bootstrap.
 */
export const MUST_CHANGE_PASSWORD_ALLOWLIST = [
    '/api/v1/account/reset-password',
    '/api/v1/account/logout',
    '/api/v1/auth/logout',
    '/api/v1/auth/refresh',
    '/api/v1/auth/refreshToken'
]

/**
 * `Path=/`-scoped, `HttpOnly` cookies set by the auth router. Read without requiring
 * `cookie-parser` to have run, for the same reason `routes/auth.ts` does: the bootstrap mounts it,
 * but a bare test app need not.
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

/** Where the request carries its resolved principal. Same property the RBAC layer reads (§C.2). */
type RequestWithUser = Request & { user?: LoggedInUser; mustChangePassword?: boolean }

const setUser = (req: Request, user: LoggedInUser, mustChangePassword: boolean): void => {
    const target = req as RequestWithUser
    target.user = user
    target.mustChangePassword = mustChangePassword
}

const getUser = (req: Request): LoggedInUser | undefined => (req as RequestWithUser).user

/**
 * §F-7 / §C.3 — the body shape the client routes on. Identical to what `rbac/PermissionCheck.ts`
 * emits for a 401, deliberately: two different 401 bodies for the same condition is how a client
 * ends up logging out on one path and hanging on another.
 */
const unauthenticatedBody = (message: string) => {
    const redirectUrl = process.env.RBAC_UNAUTHENTICATED_REDIRECT_URL || '/login'
    return {
        message,
        error: 'unauthorized',
        redirectUrl,
        redirectTo: redirectUrl,
        data: { redirectUrl }
    }
}

/**
 * Shared resolution step.
 *
 * Populates `req.user` when the cookie pair names a live session, and does nothing otherwise.
 * Never throws and never rejects: `AuthService.authenticate` already fails closed by returning
 * null, and the callers below decide what an absent principal means for their route.
 *
 * Idempotent — if a principal is already on the request (the global resolver ran first) the
 * lookup is skipped, so a request costs at most one session read.
 */
const resolvePrincipal = async (req: Request, auth: AuthService): Promise<LoggedInUser | undefined> => {
    const existing = getUser(req)
    if (existing) return existing

    const principal = await auth.authenticate(readCookie(req, SESSION_COOKIE), readCookie(req, REFRESH_COOKIE))
    if (!principal) return undefined

    // `AuthenticatedUser` widens to `LoggedInUser`; the two fields `LoggedInUser` makes required
    // are exactly the two `AuthService.authenticate` always populates for a session principal.
    const user = principal.user as LoggedInUser
    setUser(req, user, principal.mustChangePassword)
    return user
}

/**
 * MIGRATION §6 gate.
 *
 * Applied globally rather than per route, for the reason §3a gives about tenancy and which applies
 * verbatim here: "the single most common failure is one endpoint that forgot the filter". A
 * password-change requirement enforced at each handler is a requirement that one new handler will
 * silently omit.
 *
 * 403, not 401: the caller IS authenticated and the session is valid. A 401 would log the client
 * out (`ErrorContext.jsx:38`) and send it back to a sign-in that would succeed and land it right
 * back here — a loop the user cannot break. 403 keeps the session and lets the client render why.
 *
 * Anonymous requests pass straight through; they have nothing to change yet, and the routes they
 * can reach are the whitelisted ones.
 */
export const enforcePasswordChange: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
    const state = req as RequestWithUser
    if (!state.user || state.mustChangePassword !== true) {
        next()
        return
    }
    if (MUST_CHANGE_PASSWORD_ALLOWLIST.some((path) => req.path.startsWith(path))) {
        next()
        return
    }

    // Only API requests are gated. Everything else — the SPA document, its JS and CSS, the
    // favicon — must be served, or the client cannot load the very screen this 403 is telling it
    // to go to.
    //
    // This middleware is mounted globally (`app.use`) so no route can forget it, which is right.
    // But `req.path` for a browser navigating to /reset-password is `/reset-password`, not an API
    // path, so it was answered with this JSON body — and the browser rendered it as raw text. The
    // account was then unreachable through the UI at all: sign in, land on /unauthorized, navigate
    // to /reset-password, read a JSON blob. The only exit was `admin:clear-password-change` on the
    // host. QA hit this on a clean install, which means it was the out-of-box experience for every
    // new deployment (UI-01).
    //
    // Serving the shell discloses nothing: it is a static bundle, and every byte of data behind it
    // arrives over /api/v1, which is still gated by the check below.
    if (!req.path.startsWith('/api/')) {
        next()
        return
    }

    logger.warn(`[identity] blocked ${req.method} ${req.path} — password change required for user ${state.user.id ?? 'unknown'}`)
    res.status(StatusCodes.FORBIDDEN).json({
        message: 'Password change required',
        error: 'must_change_password',
        // MIGRATION §6 — the one place the caller is allowed to go. Named explicitly so a client
        // can act on the 403 without hard-coding the route.
        redirectUrl: '/reset-password',
        redirectTo: '/reset-password',
        data: { redirectUrl: '/reset-password' }
    })
}

export interface JwtCookieMiddlewareOptions {
    authService?: AuthService
}

/**
 * Mount the session layer on the application.
 *
 * `identityManager` is accepted and unused: the Apache-2.0 bootstrap passes it
 * (`index.ts:228`) because the outgoing implementation consulted it to decide which SSO strategies
 * and licence-gated auth paths to install. Flow-Wiser gates nothing on plan
 * (`identity/PlatformManager.ts`), so there is nothing to consult — but the parameter is kept so
 * the call site is unchanged and so a future deployment that DOES need per-platform wiring has the
 * seam already in place.
 *
 * Two middlewares, in this order and no other:
 *   1. resolve the principal   — permissive, so the whitelist and API-key branches still work
 *   2. enforce §6              — needs the principal from step 1
 */
export const initializeJwtCookieMiddleware = async (
    app: Application,
    _identityManager?: unknown,
    options: JwtCookieMiddlewareOptions = {}
): Promise<void> => {
    const auth = options.authService ?? new AuthService()

    app.use((req: Request, _res: Response, next: NextFunction): void => {
        void resolvePrincipal(req, auth)
            .catch((error) => {
                // Fail OPEN here only in the sense of "stay anonymous": an error resolving the
                // session must not authenticate anyone, and must not 500 a request that may well
                // be heading for a whitelisted route. The gates below still deny.
                logger.error(`❌ [identity] session resolution failed: ${error instanceof Error ? error.message : String(error)}`)
                return undefined
            })
            .then(() => next())
    })

    app.use(enforcePasswordChange)

    logger.info('🔐 [identity]: session middleware mounted')
}

/**
 * The gate for the browser-facing API (`index.ts:240`).
 *
 * Denies with `ErrorMessage.INVALID_MISSING_TOKEN`, which is the literal `ErrorContext.jsx:38`
 * compares for equality to produce a clean logout. Any other message leaves the client showing a
 * generic failure with stale credentials still in local storage.
 *
 * Resolves the principal itself when the global resolver has not run, so the function is safe to
 * call directly — which is exactly how the bootstrap uses it.
 */
export const verifyToken = (req: Request, res: Response, next: NextFunction): void => {
    const auth = defaultAuthService()
    void resolvePrincipal(req, auth)
        .then((user) => {
            if (!user) {
                res.status(StatusCodes.UNAUTHORIZED).json(unauthenticatedBody(ErrorMessage.INVALID_MISSING_TOKEN))
                return
            }
            // The §6 gate runs globally, but `verifyToken` is also called directly on a path where
            // the global resolver may have found nothing to gate. Re-check rather than assume.
            enforcePasswordChange(req, res, next)
        })
        .catch((error) => {
            logger.error(`❌ [identity] verifyToken failed closed: ${error instanceof Error ? error.message : String(error)}`)
            res.status(StatusCodes.UNAUTHORIZED).json(unauthenticatedBody(ErrorMessage.UNKNOWN_ERROR))
        })
}

/**
 * The gate for the BullMQ dashboard (`index.ts:350`).
 *
 * Stricter than {@link verifyToken} by one condition: an authenticated session is not enough, the
 * subject must hold instance-wide authority.
 *
 * WHY `isOrganizationAdmin` AND NOT A PERMISSION TOKEN. The queue dashboard is an operational
 * surface over the whole instance — it exposes every tenant's job payloads and lets a caller
 * retry or delete them. No token in the RBAC catalog (`rbac/Permissions.ts`) describes that: every
 * category there is a product resource scoped to a workspace, and picking the nearest-looking one
 * would grant cross-tenant job access to a role that was only ever meant to read its own logs.
 * `isOrganizationAdmin` is the single instance-wide authority marker the principal carries (§C.4
 * rule 1), so it is the honest gate until an admin permission category exists.
 *
 * 403 rather than 401 for an authenticated-but-unauthorised caller, matching `PermissionCheck.ts`:
 * the distinction is what stops the client logging out a user who is simply not an admin.
 */
export const verifyTokenForBullMQDashboard = (req: Request, res: Response, next: NextFunction): void => {
    const auth = defaultAuthService()
    void resolvePrincipal(req, auth)
        .then((user) => {
            if (!user) {
                res.status(StatusCodes.UNAUTHORIZED).json(unauthenticatedBody(ErrorMessage.INVALID_MISSING_TOKEN))
                return
            }
            if (user.isOrganizationAdmin !== true) {
                logger.warn(`[identity] denied /admin/queues to non-admin user ${user.id ?? 'unknown'}`)
                res.status(StatusCodes.FORBIDDEN).json({ message: ErrorMessage.FORBIDDEN })
                return
            }
            next()
        })
        .catch((error) => {
            logger.error(`❌ [identity] bullmq gate failed closed: ${error instanceof Error ? error.message : String(error)}`)
            res.status(StatusCodes.UNAUTHORIZED).json(unauthenticatedBody(ErrorMessage.UNKNOWN_ERROR))
        })
}

/**
 * One `AuthService` for the two directly-called gates.
 *
 * Lazily constructed, because `verifyToken` is exported as a bare function and module evaluation
 * happens long before the DataSource exists. `AuthService` resolves its own DataSource lazily too,
 * so a single instance is safe to share and holds no per-request state.
 */
let sharedAuthService: AuthService | undefined
const defaultAuthService = (): AuthService => {
    if (!sharedAuthService) sharedAuthService = new AuthService()
    return sharedAuthService
}

/** Test seam — lets a suite inject a stubbed service, and reset between cases. */
export const setSessionAuthService = (service: AuthService | undefined): void => {
    sharedAuthService = service
}

/**
 * Explicitly typed because the inferred shape reaches into `@types/qs` through Express's
 * generics, which tsc cannot name portably from a declaration file (TS2742).
 */
const sessionMiddleware: {
    initializeJwtCookieMiddleware: typeof initializeJwtCookieMiddleware
    verifyToken: typeof verifyToken
    verifyTokenForBullMQDashboard: typeof verifyTokenForBullMQDashboard
    enforcePasswordChange: typeof enforcePasswordChange
} = { initializeJwtCookieMiddleware, verifyToken, verifyTokenForBullMQDashboard, enforcePasswordChange }

export default sessionMiddleware
