/**
 * `TRUST_PROXY` resolution (SEC-B-09).
 *
 * The second block is the NEGATIVE test: it stands up a real Express app with a real per-IP rate
 * limiter and replays the original bypass — a different `X-Forwarded-For` on every request — against
 * the setting each configuration resolves to.
 */
import express from 'express'
import rateLimit from 'express-rate-limit'
import request from 'supertest'
import { resolveTrustProxy, TRUST_PROXY_PERMISSIVE_WARNING, TRUST_PROXY_UNSET_WARNING } from './trustProxy'

describe('resolveTrustProxy', () => {
    it.each([undefined, '', '   '])('trusts nothing and warns when TRUST_PROXY is %j', (raw) => {
        expect(resolveTrustProxy(raw)).toEqual({ setting: false, warning: TRUST_PROXY_UNSET_WARNING })
    })

    it.each(['false', 'FALSE', ' false '])('trusts nothing, silently, for %j', (raw) => {
        expect(resolveTrustProxy(raw)).toEqual({ setting: false })
    })

    it.each(['true', 'TRUE', ' true '])('honours an explicit %j but warns that it is client-controlled', (raw) => {
        expect(resolveTrustProxy(raw)).toEqual({ setting: true, warning: TRUST_PROXY_PERMISSIVE_WARNING })
    })

    it.each([
        ['1', 1],
        ['2', 2],
        ['0', 0],
        [' 3 ', 3]
    ])('reads %j as a hop count', (raw, expected) => {
        expect(resolveTrustProxy(raw)).toEqual({ setting: expected })
    })

    it.each(['loopback', 'loopback, 10.0.0.0/8', '192.168.0.1', '-1', '1.5', '1e3'])('passes %j through for Express to parse', (raw) => {
        expect(resolveTrustProxy(raw)).toEqual({ setting: raw })
    })
})

describe('X-Forwarded-For spoofing against a per-IP rate limit', () => {
    const LIMIT = 3

    const appFor = (raw: string | undefined) => {
        const app = express()
        app.set('trust proxy', resolveTrustProxy(raw).setting)
        app.use(rateLimit({ windowMs: 60_000, max: LIMIT, standardHeaders: false, legacyHeaders: false, validate: false }))
        app.get('/ip', (req, res) => res.json({ ip: req.ip }))
        return app
    }

    /** `count` requests, each claiming a different client address. Returns the status codes. */
    const spoofed = async (app: express.Express, count: number): Promise<number[]> => {
        const statuses: number[] = []
        for (let i = 0; i < count; i++) {
            statuses.push(
                (
                    await request(app)
                        .get('/ip')
                        .set('X-Forwarded-For', `203.0.113.${i + 1}`)
                ).status
            )
        }
        return statuses
    }

    it.each([undefined, '', 'false', '0'])('TRUST_PROXY=%j: a forged header neither sets req.ip nor evades the limit', async (raw) => {
        const app = appFor(raw)
        const first = await request(app).get('/ip').set('X-Forwarded-For', '203.0.113.200')
        expect(first.body.ip).not.toBe('203.0.113.200')

        const statuses = await spoofed(app, LIMIT + 2)
        expect(statuses.filter((s) => s === 429).length).toBe(3) // 1 + (LIMIT + 2) requests, LIMIT allowed
    })

    it('TRUST_PROXY=1: only the address written by the nearest proxy is believed', async () => {
        const app = appFor('1')
        // What a client behind one proxy can do: prepend entries. The proxy appends the real peer last.
        const res = await request(app).get('/ip').set('X-Forwarded-For', '198.51.100.9, 203.0.113.7')
        expect(res.body.ip).toBe('203.0.113.7')
    })

    it('TRUST_PROXY=true reproduces the original bypass — which is why it is warned about', async () => {
        const app = appFor('true')
        const res = await request(app).get('/ip').set('X-Forwarded-For', '203.0.113.200')
        expect(res.body.ip).toBe('203.0.113.200')
        expect((await spoofed(app, LIMIT + 2)).every((s) => s === 200)).toBe(true)
    })
})
