import { CookieOptions, NextFunction, Request, Response, Router } from 'express'
import { StatusCodes } from 'http-status-codes'
import { AuthService } from '../services/AuthService'
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
 * `POST /account/reset-password` is now implemented, for the SESSION-AUTHENTICATED case only.
 *
 * WHY IT HAD TO BE. This comment previously said the recovery CLI was the way through for an
 * account carrying `mustChangePassword`. That was not true: nothing anywhere in the codebase ever
 * set the flag back to false — not this router, not `admin:reset-password` (which sets it to
 * true), not the migration tool. A fresh install therefore bricked itself. You created the first
 * administrator, signed in successfully, and every subsequent request returned 403
 * `must_change_password` forever, with no exit over HTTP or CLI. Found by booting the server and
 * driving a real first login; no unit test would have shown it, because each piece worked.
 *
 * TWO FLOWS, ONE PATH. The Apache-2.0 client posts `{ user: { email, tempToken, password } }`
 * here (`packages/ui/src/api/account.api.js:8`, `views/auth/resetPassword.jsx:102-106`) for the
 * FORGOTTEN-password flow, where the tempToken is proof of identity delivered by email. That
 * flow still answers 501 — there is no transactional email path in this build, so no token can
 * ever be issued.
 *
 * The forced-change flow is a different thing wearing the same URL: the caller is already
 * authenticated. A live session is strictly stronger evidence than an emailed token, so no token
 * is required — but the CURRENT password is, which the emailed-token flow cannot ask for. That
 * closes the gap a stolen session cookie would otherwise open: possession of the cookie alone
 * must not be enough to seize the account by changing its password.
 *
 * This is a deliberate divergence from the shipped client, recorded here rather than inferred.
 * The client cannot yet drive it (its form requires a token before it will submit); the CLI and
 * API can. Teaching the client the session-authenticated variant is follow-up work.
 */

/** Mirrors the cookie attributes `routes/auth.ts` sets, so `clearCookie` actually matches them. */
const cookieOptions = (env: NodeJS.ProcessEnv, path: string): CookieOptions => ({
    httpOnly: true,
    secure: env.IDENTITY_COOKIE_SECURE === undefined ? env.NODE_ENV === 'production' : env.IDENTITY_COOKIE_SECURE === 'true',
    sameSite: 'lax',
    path
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
     * `POST /account/reset-password` — session-authenticated password change.
     *
     * Body follows the shipped client's envelope, `{ user: { email, password, currentPassword } }`,
     * so a client that already builds that object needs only to swap `tempToken` for
     * `currentPassword`. A `tempToken` in the body means the caller wants the emailed-token flow,
     * which this build cannot serve — that is answered 501 below rather than silently treated as
     * something else.
     */
    router.post('/reset-password', (req: Request, res: Response, next: NextFunction) => {
        void (async () => {
            const body = (req.body ?? {}) as { user?: Record<string, unknown> }
            const payload = (body.user ?? {}) as Record<string, unknown>

            if (typeof payload.tempToken === 'string' && payload.tempToken.length > 0) {
                res.status(StatusCodes.NOT_IMPLEMENTED).json({
                    message: 'Token-based password reset is not implemented in this build',
                    error: 'not_implemented',
                    reason: 'Resetting a password by emailed token requires a transactional email path, which is not configured. Sign in and change the password with your current one, or use the recovery CLI.'
                })
                return
            }

            const principal = (req as Request & { user?: { id?: string; email?: string } }).user
            if (!principal?.id) {
                res.status(StatusCodes.UNAUTHORIZED).json({
                    message: 'Sign in before changing your password',
                    error: 'unauthenticated'
                })
                return
            }

            // A signed-in caller may only change their OWN password here. Changing someone else's
            // is administration, and administration is not implemented in this build — it must not
            // arrive through a self-service endpoint by passing a different address.
            if (typeof payload.email === 'string' && payload.email.trim().toLowerCase() !== (principal.email ?? '').toLowerCase()) {
                res.status(StatusCodes.FORBIDDEN).json({
                    message: 'You can only change your own password here',
                    error: 'forbidden'
                })
                return
            }

            const result = await auth.changeOwnPassword(principal.id, payload.currentPassword, payload.password, {
                ip: req.ip ?? null,
                userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
                route: 'POST /account/reset-password'
            })

            if (!result.ok) {
                res.status(result.status).json(result.body)
                return
            }

            // Every other session for this account was revoked, including any an attacker held.
            // This one was reissued, so the caller stays signed in rather than being bounced to a
            // login screen immediately after successfully proving their current password.
            res.cookie(SESSION_COOKIE, result.session.sessionId, cookieOptions(env, sessionCookiePath))
            res.cookie(REFRESH_COOKIE, result.session.refreshSecret, cookieOptions(env, refreshCookiePath))
            res.status(StatusCodes.OK).json(result.body)
        })().catch(next)
    })

    router.use(
        notImplementedRouter(
            'Account self-service',
            'Registration, invitations, email verification and password reset by emailed token require a transactional email path that is not configured in this build. Sign-in, sign-out and session-authenticated password change are implemented.'
        )
    )

    return router
}

export default createAccountRouter
