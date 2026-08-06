import { CookieOptions, NextFunction, Request, Response, Router } from 'express'
import { StatusCodes } from 'http-status-codes'
import logger from '../../utils/logger'
import { AuthService, PasswordChangeFailure } from '../services/AuthService'
import { REFRESH_COOKIE, SESSION_COOKIE } from './auth'
import { notImplementedRouter } from './notImplemented'

/**
 * `/account` — the self-service surface.
 *
 * CLEAN-ROOM PROVENANCE. Paths from the Apache-2.0 client, `packages/ui/src/api/account.api.js`,
 * and from `utils/constants.ts` WHITELIST_URLS, which whitelists seven of them by prefix.
 *
 * Exactly ONE is implemented here: `POST /account/logout`. It is the endpoint the shipped client
 * actually calls to sign out (`account.api.js:10`), and SPEC-AUTH-RBAC §E.5 requires it to work on
 * an already-dead session — which is why it is whitelisted, and why it must clear cookies whatever
 * the outcome of the revocation.
 *
 * The rest — register, invite, verify, resend-verification, confirm-email-change, forgot-password,
 * reset-password, billing, delete — all require a transactional email path and an invitation model
 * that the identity layer does not have yet. They answer 501; see `notImplemented.ts`.
 *
 * ONE CONSEQUENCE WORTH STATING PLAINLY, now resolved: `POST /account/reset-password` is the
 * change-password endpoint that MIGRATION §6 exempts from the `mustChangePassword` block
 * (`identity/middleware/session.ts`). It is implemented below, for the SESSION-AUTHENTICATED branch
 * only. Until it existed, `admin:create` produced an account that could sign in and log out and
 * nothing else, for ever, because no code path anywhere set `mustChangePassword` back to false.
 *
 * ── ONE PATH, TWO FLOWS, AND ONLY ONE OF THEM IS BUILT ───────────────────────────────────────
 * `packages/ui/src/api/account.api.js:9` posts to this single path for both:
 *
 *   FORGOTTEN password   `{ user: { email, tempToken, password } }` — the proof is a token mailed to
 *                        the address. There is no transactional email path in this build, so there
 *                        is no way to issue that token and no way to verify one. A body carrying
 *                        `tempToken` is answered 501, not 400: the request is well-formed and the
 *                        server simply does not implement it, and pretending otherwise would send
 *                        the operator hunting for a typo.
 *   FORCED change        `{ user: { email, currentPassword, password } }` — the proof is the CURRENT
 *                        password, over the caller's own session. This is the §6 exit and it is what
 *                        the handler below implements.
 *
 * ── The route is whitelisted, so it authenticates itself ─────────────────────────────────────
 * `utils/constants.ts` WHITELIST_URLS names `/api/v1/account/reset-password` by prefix, which means
 * the bootstrap's gate (`index.ts:240`) never runs for it and an anonymous caller reaches this
 * handler. That is correct for the forgotten-password flow — which by definition has no session —
 * and it makes resolving the principal this handler's own job rather than the middleware's.
 */

/** Mirrors the cookie attributes `routes/auth.ts` sets, so `clearCookie` actually matches them. */
const cookieOptions = (env: NodeJS.ProcessEnv, path: string, maxAgeMs?: number): CookieOptions => ({
    httpOnly: true,
    secure: env.IDENTITY_COOKIE_SECURE === undefined ? env.NODE_ENV === 'production' : env.IDENTITY_COOKIE_SECURE === 'true',
    sameSite: 'lax',
    path,
    ...(maxAgeMs ? { maxAge: maxAgeMs } : {})
})

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

/**
 * One status per refusal, declared in one place so a new failure cannot inherit an old one's meaning.
 *
 * 403 and not 401 for WRONG_SUBJECT: the caller IS authenticated and simply may not do this. A 401
 * would log the shipped client out over what is, most often, a stale email left in the form field.
 * 409 for NO_LOCAL_CREDENTIAL: nothing about the request is malformed — the account state is what
 * makes it impossible.
 */
const PASSWORD_CHANGE_STATUS: Record<PasswordChangeFailure, number> = {
    [PasswordChangeFailure.WRONG_SUBJECT]: StatusCodes.FORBIDDEN,
    [PasswordChangeFailure.INVALID_CREDENTIALS]: StatusCodes.UNAUTHORIZED,
    [PasswordChangeFailure.NO_LOCAL_CREDENTIAL]: StatusCodes.CONFLICT,
    [PasswordChangeFailure.WEAK_PASSWORD]: StatusCodes.BAD_REQUEST,
    [PasswordChangeFailure.UNCHANGED]: StatusCodes.BAD_REQUEST,
    [PasswordChangeFailure.INTERNAL_ERROR]: StatusCodes.INTERNAL_SERVER_ERROR
}

export interface AccountRouterOptions {
    authService?: AuthService
    env?: NodeJS.ProcessEnv
}

export const createAccountRouter = (options: AccountRouterOptions = {}): Router => {
    const env = options.env ?? process.env
    const auth = options.authService ?? new AuthService({ env })
    const router = Router()

    const sessionCookiePath = env.IDENTITY_COOKIE_PATH || '/'
    const refreshCookiePath = env.IDENTITY_REFRESH_COOKIE_PATH || sessionCookiePath

    /**
     * `POST /account/logout` — §E.5.
     *
     * Always 200. The caller is entitled to have its cookies cleared regardless of whether the
     * session was still alive; a 401 here would leave them in place, which is the opposite of what
     * "log out" means. `AuthService.logout` already declines to throw for the same reason.
     */
    router.post('/logout', (req: Request, res: Response, next: NextFunction) => {
        void (async () => {
            const result = await auth.logout(readCookie(req, SESSION_COOKIE), {
                ip: req.ip ?? null,
                userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
                route: 'POST /account/logout'
            })
            res.clearCookie(SESSION_COOKIE, cookieOptions(env, sessionCookiePath))
            res.clearCookie(REFRESH_COOKIE, cookieOptions(env, refreshCookiePath))
            res.status(StatusCodes.OK).json(result)
        })().catch(next)
    })

    /**
     * `POST /account/reset-password` — MIGRATION §6's exit, session-authenticated branch.
     *
     * See the module header for why one path carries two flows and why only this one is built.
     */
    router.post('/reset-password', (req: Request, res: Response, next: NextFunction) => {
        void (async () => {
            // The shipped client nests everything under `user` (`resetPassword.jsx:101-107`). A flat
            // body is accepted too, so `curl` and any future client need not know that.
            const body = (req.body ?? {}) as { user?: Record<string, unknown> } & Record<string, unknown>
            const fields = (body.user && typeof body.user === 'object' ? body.user : body) as Record<string, unknown>

            // The forgotten-password flow, answered honestly. Checked FIRST and before any session
            // lookup: a caller presenting a token is not claiming to hold a session, and telling them
            // "unauthorized" would send them to a sign-in screen that cannot help them either.
            if (typeof fields.tempToken === 'string' && fields.tempToken.trim().length > 0) {
                logger.warn('[identity] 501 POST /account/reset-password — the token (forgotten-password) flow is not implemented')
                res.status(StatusCodes.NOT_IMPLEMENTED).json({
                    message: 'Password reset by emailed token is not available on this instance',
                    error: 'not_implemented',
                    detail:
                        'Resetting a forgotten password requires a transactional email path that is not configured in this build. ' +
                        'A signed-in user can change their own password by supplying the current one; an operator can clear a ' +
                        'forced password change with `flow-wiser admin:clear-password-change`, or set a new password with ' +
                        '`flow-wiser admin:reset-password`.'
                })
                return
            }

            const principal = await auth.authenticate(readCookie(req, SESSION_COOKIE), readCookie(req, REFRESH_COOKIE))
            if (!principal) {
                // NOT the `Invalid or Missing token` literal: that string makes the client drop its
                // stored user and bounce to /signin (`ErrorContext.jsx:38`), which for a user who is
                // signed in and merely got the current password wrong would be a logout loop.
                res.status(StatusCodes.UNAUTHORIZED).json({
                    message: 'Sign in before changing your password.',
                    error: 'unauthorized'
                })
                return
            }

            // `principal.session.userId` and NOT `principal.user.id`: the latter is optional on
            // `AuthenticatedUser` because the API-key branch has no user (§C.2), whereas the session
            // ROW always names its owner. Which account is being changed is the one fact this handler
            // may not get wrong, so it is read from the column that cannot be absent.
            const result = await auth.changeOwnPassword(
                { userId: principal.session.userId, activeWorkspaceId: principal.user.activeWorkspaceId ?? null },
                { email: fields.email, currentPassword: fields.currentPassword, newPassword: fields.password },
                {
                    ip: req.ip ?? null,
                    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
                    route: 'POST /account/reset-password'
                }
            )

            if (!result.ok) {
                res.status(PASSWORD_CHANGE_STATUS[result.failure]).json({
                    message: result.message,
                    error: result.failure,
                    ...(result.violations ? { violations: result.violations } : {})
                })
                return
            }

            // The change revoked every session including the caller's own. Handing back the
            // replacement keeps them signed in — a forced change that ends on a login screen is
            // indistinguishable from a failure.
            const maxAgeMs = Math.max(result.session.expiresDate.getTime() - Date.now(), 0)
            res.cookie(SESSION_COOKIE, result.session.sessionId, cookieOptions(env, sessionCookiePath, maxAgeMs))
            res.cookie(REFRESH_COOKIE, result.session.refreshSecret, cookieOptions(env, refreshCookiePath, maxAgeMs))
            res.status(StatusCodes.OK).json({
                message: 'password_changed',
                // Named explicitly so a client can stop showing the forced-change screen without
                // having to re-fetch the whole login payload to find out.
                mustChangePassword: false,
                sessionsRevoked: result.sessionsRevoked
            })
        })().catch(next)
    })

    router.use(
        notImplementedRouter(
            'Account self-service',
            'Registration, invitations, email verification and password reset require a transactional email path that is not configured in this build. Sign-in and sign-out are implemented.'
        )
    )

    return router
}

export default createAccountRouter
