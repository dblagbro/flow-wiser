/**
 * Vault bundle client — one signed read, against a real HTTP server on loopback.
 *
 * The stub server verifies the Ed25519 signature the way the hub does (rebuilding the RFC 9421 base
 * from the request it actually received), so "the request is correctly signed" is checked over a
 * real socket rather than by inspecting headers. All secret values are synthetic and generated at
 * run time.
 */
import { generateKeyPairSync, KeyObject, randomBytes, verify } from 'node:crypto'
import http from 'node:http'
import { AddressInfo } from 'node:net'
import { fetchBundle, FetchBundleInput, MAX_BUNDLE_BYTES } from './bundleClient'

const NS = 'coordinator-hub/services/fixture-example'
const PREFIX = '/claudeCoordinator/api/v1/vault'
const AUTHORITY = 'hub.example.test:8232'
const KEYID = 'fixture-example-reader'
const canary = (): string => `canary-${randomBytes(12).toString('hex')}`

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void

describe('fetchBundle', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    let server: http.Server
    let handler: Handler
    let seen: http.IncomingMessage[]
    let baseUrl: string

    const input = (extra: Partial<FetchBundleInput> = {}): FetchBundleInput => ({
        baseUrl,
        authority: AUTHORITY,
        prefix: PREFIX,
        namespace: NS,
        keyid: KEYID,
        key: privateKey,
        timeoutMs: 2000,
        ...extra
    })
    const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers })
        res.end(JSON.stringify(body))
    }
    const goodBundle = () => ({
        namespace: NS,
        etag: '"v7"',
        items: [
            { path: `${NS}/master-key`, version: 2, data: { value: canary() } },
            { path: `${NS}/session-pepper`, version: 1, data: { value: canary() } }
        ],
        tombstones: [],
        withheld: []
    })

    /** Verify the request's signature exactly as a hub with the pinned profile would. */
    const signatureValid = (req: http.IncomingMessage, key: KeyObject): boolean => {
        const inputHeader = String(req.headers['signature-input'] ?? '')
        const inner = inputHeader.replace(/^[^=]+=/, '')
        const components = [...(/^\(([^)]*)\)/.exec(inner)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1])
        const [path, query] = String(req.url).split('?')
        const value: Record<string, string> = {
            '@method': String(req.method),
            '@authority': AUTHORITY,
            '@path': path,
            '@query': `?${query ?? ''}`
        }
        const base = [...components.map((c) => `"${c}": ${value[c]}`), `"@signature-params": ${inner}`].join('\n')
        const signature = Buffer.from(/=:(.*):$/.exec(String(req.headers.signature ?? ''))?.[1] ?? '', 'base64')
        return verify(null, Buffer.from(base, 'utf8'), key, signature)
    }

    beforeEach(async () => {
        seen = []
        handler = (_req, res) => json(res, 200, goodBundle(), { ETag: '"v7"' })
        server = http.createServer((req, res) => {
            seen.push(req)
            handler(req, res)
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    })
    afterEach(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    it('reads a bundle with one correctly signed GET', async () => {
        handler = (req, res) =>
            signatureValid(req, publicKey) ? json(res, 200, goodBundle(), { ETag: '"v7"' }) : json(res, 401, { error: 'signature_invalid' })
        const result = await fetchBundle(input())
        expect(result.outcome).toBe('bundle')
        if (result.outcome !== 'bundle') return
        expect(result.bundle.items.map((i) => i.path)).toEqual([`${NS}/master-key`, `${NS}/session-pepper`])
        expect(result.classification).toEqual({ state: 'OK', code: 'ok', clearCache: false })
        expect(seen).toHaveLength(1)
        expect(seen[0].method).toBe('GET')
        expect(seen[0].url).toBe(`${PREFIX}/ns/${NS}`)
        expect(seen[0].headers['signature-input']).toMatch(
            new RegExp(`^sig1=\\("@method" "@authority" "@path"\\);created=\\d+;keyid="${KEYID}";alg="ed25519";nonce="`)
        )
    })

    it('signs the hub authority and sends it as Host, whatever address it connects to', async () => {
        await fetchBundle(input())
        expect(seen[0].headers.host).toBe('hub.example.test:8232')
        expect(signatureValid(seen[0], publicKey)).toBe(true)
    })

    it('is refused by a server that enrolled a different key', async () => {
        const other = generateKeyPairSync('ed25519').publicKey
        handler = (req, res) => (signatureValid(req, other) ? json(res, 200, goodBundle()) : json(res, 401, { error: 'signature_invalid' }))
        const result = await fetchBundle(input())
        expect(result).toEqual({
            outcome: 'no_bundle',
            classification: { state: 'REQUEST_REJECTED', code: 'signature_invalid', clearCache: false }
        })
    })

    it('uses a fresh nonce on every request', async () => {
        await fetchBundle(input())
        await fetchBundle(input())
        const nonce = (req: http.IncomingMessage) => /nonce="([^"]+)"/.exec(String(req.headers['signature-input']))?.[1]
        expect(nonce(seen[0])).toBeTruthy()
        expect(nonce(seen[0])).not.toBe(nonce(seen[1]))
    })

    it('sends If-None-Match and reports 304 as not modified', async () => {
        handler = (req, res) => {
            if (req.headers['if-none-match'] === '"v7"') {
                res.writeHead(304)
                res.end()
            } else json(res, 200, goodBundle())
        }
        expect(await fetchBundle(input({ etag: '"v7"' }))).toEqual({
            outcome: 'not_modified',
            classification: { state: 'NOT_MODIFIED', code: 'not_modified', clearCache: false }
        })
        expect((await fetchBundle(input())).outcome).toBe('bundle')
    })

    it.each([
        ['revoked', 403, { error: 'revoked' }, 'REVOKED', true],
        ['grant_denied', 403, { error: 'grant_denied' }, 'DENIED', true],
        ['sealed', 503, { error: 'vault_sealed' }, 'UNREACHABLE', false],
        ['clock_skew', 401, { error: 'clock_skew' }, 'REQUEST_REJECTED', false],
        ['a proxy 502', 502, undefined, 'UNREACHABLE', false],
        ['a bare 403', 403, undefined, 'UNEXPECTED', false],
        ['a 500', 500, { error: 'internal' }, 'UNEXPECTED', false]
    ])('reports %s without a bundle (clear=%s)', async (_name, status, body, state, clear) => {
        handler = (_req, res) =>
            body
                ? json(res, status as number, body, status === 503 ? { 'X-Vault-State': 'sealed' } : {})
                : (res.writeHead(status as number), res.end('<html>error</html>'))
        const result = await fetchBundle(input())
        expect(result.outcome).toBe('no_bundle')
        expect(result.classification).toMatchObject({ state, clearCache: clear })
    })

    it('reports an unreachable server as UNREACHABLE and clears nothing', async () => {
        const result = await fetchBundle(input({ baseUrl: 'http://127.0.0.1:1' }))
        expect(result).toEqual({ outcome: 'no_bundle', classification: { state: 'UNREACHABLE', code: 'no_response', clearCache: false } })
    })

    it('gives up at the timeout instead of waiting for a server that never answers', async () => {
        handler = () => undefined
        const started = Date.now()
        const result = await fetchBundle(input({ timeoutMs: 300 }))
        expect(Date.now() - started).toBeLessThan(2500)
        expect(result).toMatchObject({ outcome: 'no_bundle', classification: { state: 'UNREACHABLE', clearCache: false } })
    })

    it('does not follow a redirect', async () => {
        handler = (req, res) => {
            if (req.url === '/elsewhere') return json(res, 200, goodBundle())
            res.writeHead(302, { Location: '/elsewhere' })
            res.end()
        }
        const result = await fetchBundle(input())
        expect(result).toEqual({ outcome: 'no_bundle', classification: { state: 'UNEXPECTED', code: 'http_302', clearCache: false } })
        expect(seen).toHaveLength(1)
    })

    it.each([
        ['is not JSON', (res: http.ServerResponse) => (res.writeHead(200), res.end('<html>login</html>')), 'malformed_bundle'],
        [
            'is for another namespace',
            (res: http.ServerResponse) => json(res, 200, { ...goodBundle(), namespace: 'coordinator-hub/services/other' }),
            'wrong_namespace'
        ],
        ['lacks a field', (res: http.ServerResponse) => json(res, 200, { namespace: NS, etag: 'e', items: [] }), 'malformed_bundle'],
        ['is empty', (res: http.ServerResponse) => (res.writeHead(200), res.end()), 'malformed_bundle']
    ])('refuses a 200 whose body %s, as untrusted and never partial', async (_name, respond, reason) => {
        handler = (_req, res) => respond(res)
        const result = await fetchBundle(input())
        expect(result).toEqual({ outcome: 'untrusted_bundle', classification: { state: 'OK', code: 'ok', clearCache: false }, reason })
    })

    it('refuses a body larger than the cap', async () => {
        handler = (_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ...goodBundle(), padding: 'x'.repeat(MAX_BUNDLE_BYTES + 10) }))
        }
        expect(await fetchBundle(input())).toEqual({
            outcome: 'no_bundle',
            classification: { state: 'UNEXPECTED', code: 'body_too_large', clearCache: false }
        })
    })

    it('never includes a value in what it returns for a failure', async () => {
        const secret = canary()
        handler = (_req, res) =>
            json(res, 200, {
                namespace: NS,
                etag: 'e',
                items: [{ path: `${NS}/k`, version: 0, data: { value: secret } }],
                tombstones: [],
                withheld: []
            })
        expect(JSON.stringify(await fetchBundle(input()))).not.toContain(secret)
    })

    it.each(['../etc', 'a/../b', 'a/./b', '..', '.', 'a//b', '/leading', 'trailing/', 'has space', 'q?x=1', 'a#b', 'a%2f..', ''])(
        'refuses the namespace %j before sending anything',
        async (namespace) => {
            await expect(fetchBundle(input({ namespace }))).rejects.toThrow(/not a valid path/)
            expect(seen).toHaveLength(0)
        }
    )

    // Found on the first live run: the hub verifies a bare host[:port]; signing `http://host:port` is
    // answered 401. Refused here, before a request that can only fail is sent.
    it.each([
        'http://hub.example.test:8232',
        'https://hub.example.test',
        'hub.example.test:8232/',
        'hub.example.test/path',
        'hub example',
        ''
    ])('refuses the authority %j, which is not a bare host[:port]', async (authority) => {
        await expect(fetchBundle(input({ authority }))).rejects.toThrow(/bare host/)
        expect(seen).toHaveLength(0)
    })

    it.each(['hub.example.test', '127.0.0.1:8232', '[::1]:8232'])('accepts the authority %j', async (authority) => {
        await fetchBundle(input({ authority }))
        expect(seen[0].headers.host).toBe(authority)
    })

    it('refuses a base URL that is not http or https', async () => {
        await expect(fetchBundle(input({ baseUrl: 'file:///etc/passwd' }))).rejects.toThrow(/http or https/)
    })
})
