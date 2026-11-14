/**
 * `POST /account/reset-password` rate limits (I-07).
 *
 * The route verifies the caller's CURRENT password over their session, and had no limiter — a
 * password oracle for anyone holding a session cookie. The first test is the negative one: it
 * replays the guessing loop and asserts the oracle stops answering.
 *
 * The router is real; only AuthService is a stub, injected through the option the router already
 * exposes, so no database is involved.
 */
import express from 'express'
import request from 'supertest'
import { createAccountRouter } from './account'
import { SESSION_COOKIE } from './auth'
import { PasswordChangeFailure } from '../services/AuthService'

jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}))

const RIGHT_PASSWORD = 'correct horse battery staple'

const buildApp = (env: Record<string, string> = {}) => {
    const changeOwnPassword = jest.fn(async (_subject: unknown, input: { currentPassword?: unknown }) =>
        input.currentPassword === RIGHT_PASSWORD
            ? { ok: true, session: { sessionId: 'new-session', refreshSecret: 'new-refresh', expiresDate: new Date(Date.now() + 60_000) } }
            : { ok: false, failure: PasswordChangeFailure.INVALID_CREDENTIALS, message: 'Current password is incorrect.' }
    )
    const authenticate = jest.fn(async (sessionId: string | undefined) =>
        sessionId ? { session: { userId: `user-of-${sessionId}` }, user: { activeWorkspaceId: null } } : null
    )
    const app = express()
    app.use(express.json())
    app.use(
        '/account',
        createAccountRouter({
            authService: { authenticate, changeOwnPassword } as never,
            env: { IDENTITY_LOGIN_RATE_MAX_PER_ACCOUNT: '3', IDENTITY_LOGIN_RATE_MAX_PER_IP: '8', ...env } as NodeJS.ProcessEnv
        })
    )
    return { app, changeOwnPassword }
}

const attempt = (app: express.Express, session: string | null, currentPassword: string) => {
    const req = request(app).post('/account/reset-password')
    if (session) req.set('Cookie', `${SESSION_COOKIE}=${session}`)
    return req.send({ user: { email: 'a@example.test', currentPassword, password: 'a-new-long-password-1' } })
}

describe('POST /account/reset-password rate limits (I-07)', () => {
    it('stops answering a session that keeps guessing the current password', async () => {
        const { app, changeOwnPassword } = buildApp()
        const statuses: number[] = []
        for (let i = 0; i < 6; i++) statuses.push((await attempt(app, 'stolen-session', `guess-${i}`)).status)

        expect(statuses).toEqual([401, 401, 401, 429, 429, 429])
        // The oracle was consulted three times, not six — and not at all once limited, even with
        // the right answer.
        expect(changeOwnPassword).toHaveBeenCalledTimes(3)
        expect((await attempt(app, 'stolen-session', RIGHT_PASSWORD)).status).toBe(429)
        expect(changeOwnPassword).toHaveBeenCalledTimes(3)
    })

    it('answers 429 with Retry-After and the type the client shows a banner for', async () => {
        const { app } = buildApp()
        for (let i = 0; i < 3; i++) await attempt(app, 's1', 'wrong')
        const limited = await attempt(app, 's1', 'wrong')
        expect(limited.status).toBe(429)
        expect(limited.headers['retry-after']).toBe('900')
        expect(limited.body).toMatchObject({ type: 'authentication_rate_limit', retryAfter: 900 })
    })

    it('does not spend the budget on successful changes', async () => {
        const { app } = buildApp()
        for (let i = 0; i < 5; i++) expect((await attempt(app, 'honest-session', RIGHT_PASSWORD)).status).toBe(200)
    })

    it('limits each session separately', async () => {
        const { app } = buildApp()
        for (let i = 0; i < 3; i++) await attempt(app, 'session-a', 'wrong')
        expect((await attempt(app, 'session-a', 'wrong')).status).toBe(429)
        expect((await attempt(app, 'session-b', 'wrong')).status).toBe(401)
    })

    it('bounds one address across many sessions, so minting sessions does not reset the count', async () => {
        const { app } = buildApp()
        const statuses: number[] = []
        for (let i = 0; i < 10; i++) statuses.push((await attempt(app, `session-${i}`, 'wrong')).status)
        expect(statuses.slice(0, 8).every((s) => s === 401)).toBe(true)
        expect(statuses.slice(8)).toEqual([429, 429])
    })

    it('bounds anonymous callers too — the route is whitelisted and reachable without a session', async () => {
        const { app } = buildApp()
        const statuses: number[] = []
        for (let i = 0; i < 5; i++) statuses.push((await attempt(app, null, 'wrong')).status)
        expect(statuses).toEqual([401, 401, 401, 429, 429])
    })

    it('uses the login limiter defaults when nothing is configured', async () => {
        const { app } = buildApp({ IDENTITY_LOGIN_RATE_MAX_PER_ACCOUNT: '', IDENTITY_LOGIN_RATE_MAX_PER_IP: '' })
        const statuses: number[] = []
        for (let i = 0; i < 11; i++) statuses.push((await attempt(app, 'default-session', 'wrong')).status)
        expect(statuses.filter((s) => s === 401)).toHaveLength(10)
        expect(statuses[10]).toBe(429)
    })
})
