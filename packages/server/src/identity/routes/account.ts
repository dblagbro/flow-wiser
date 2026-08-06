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
 * ONE CONSEQUENCE WORTH STATING PLAINLY: `POST /account/reset-password` is the change-password
 * endpoint that MIGRATION §6 exempts from the `mustChangePassword` block
 * (`identity/middleware/session.ts`). Until it is implemented, an account carrying that flag can
 * sign in and can log out, but cannot clear the flag over HTTP — the recovery CLI (§7) is the only
 * way through. The middleware allowlist already names the path, so implementing the handler is the
 * whole of the remaining work.
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

    router.use(
        notImplementedRouter(
            'Account self-service',
            'Registration, invitations, email verification and password reset require a transactional email path that is not configured in this build. Sign-in and sign-out are implemented.'
        )
    )

    return router
}

export default createAccountRouter
