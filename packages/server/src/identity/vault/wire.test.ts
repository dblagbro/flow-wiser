/**
 * Vault wire states and bundle reading (hub ONBOARDING §5.1, contract v1 §8).
 *
 * The first block is the one rule that matters most — ONLY an explicit `revoked` or `grant_denied`
 * from the hub clears a cache — tested from both sides: everything that must clear it, and a long
 * list of things that look alarming and must not.
 *
 * All secret values here are synthetic markers generated at run time.
 */
import { randomBytes } from 'node:crypto'
import { Bundle, classifyResponse, isVaultIdentity, parseBundle, resolveSecret, VAULT_IDENTITY, VaultBundleError } from './wire'

const NS = 'coordinator-hub/services/fixture-example'
const canary = (): string => `canary-${randomBytes(12).toString('hex')}`

describe('classifyResponse — only an explicit revoke or denial clears the cache', () => {
    it.each([
        [401, 'revoked', 'REVOKED'],
        [403, 'revoked', 'REVOKED'],
        [401, 'grant_denied', 'DENIED'],
        [403, 'grant_denied', 'DENIED']
    ])('%i {error: %j} → %s, clear the cache', (status, error, state) => {
        expect(classifyResponse({ status, body: { error, message: 'x' } })).toEqual({ state, code: error, clearCache: true })
    })

    // NEGATIVE cases: each of these is "something is wrong", and none of them is the hub
    // withdrawing a credential.
    it.each([
        ['no response at all (timeout, refused, DNS)', { status: undefined }],
        ['502 from a proxy', { status: 502 }],
        ['504 from a proxy', { status: 504 }],
        ['503 sealed', { status: 503, headers: { 'X-Vault-State': 'sealed' }, body: { error: 'vault_sealed' } }],
        ['503 degraded', { status: 503, headers: { 'x-vault-state': 'degraded' }, body: { error: 'vault_engine_unavailable' } }],
        ['503 with no body', { status: 503 }],
        ['401 signature_invalid', { status: 401, body: { error: 'signature_invalid' } }],
        ['401 clock_skew', { status: 401, body: { error: 'clock_skew' } }],
        ['401 nonce_replay', { status: 401, body: { error: 'nonce_replay' } }],
        ['401 unauthenticated', { status: 401, body: { error: 'unauthenticated' } }],
        ['429 rate_limited', { status: 429, body: { error: 'rate_limited' } }],
        ['429 with no body', { status: 429 }],
        ['502 upstream_verify_failed', { status: 502, body: { error: 'upstream_verify_failed' } }],
        ['a bare 401 with no hub error body (a proxy login page)', { status: 401 }],
        ['a bare 403 with no hub error body (a WAF block)', { status: 403 }],
        ['403 with an HTML body that failed to parse', { status: 403, body: undefined }],
        ['403 with a JSON body that is not the hub error shape', { status: 403, body: { detail: 'Forbidden' } }],
        ['403 with error as a non-string', { status: 403, body: { error: { code: 'revoked' } } }],
        ['403 insufficient_scope', { status: 403, body: { error: 'insufficient_scope' } }],
        ['403 path_not_in_namespace', { status: 403, body: { error: 'path_not_in_namespace' } }],
        ['403 disclose_class', { status: 403, body: { error: 'disclose_class' } }],
        ['404 not_found', { status: 404, body: { error: 'not_found' } }],
        ['410 tombstone', { status: 410, body: { error: 'tombstone' } }],
        ['400 invalid_request', { status: 400, body: { error: 'invalid_request' } }],
        ['413 body_too_large', { status: 413, body: { error: 'body_too_large' } }],
        ['500', { status: 500 }],
        ['501 not_implemented (slice not landed)', { status: 501, body: { error: 'not_implemented' } }],
        ['200 whose body happens to say revoked', { status: 200, body: { error: 'revoked' } }],
        ['500 whose body says revoked', { status: 500, body: { error: 'revoked' } }],
        ['503 whose body says grant_denied', { status: 503, body: { error: 'grant_denied' } }],
        ['a string body saying revoked', { status: 403, body: 'revoked' }],
        ['an array body', { status: 403, body: ['revoked'] }],
        ['the word revoked with different case', { status: 403, body: { error: 'Revoked' } }],
        ['revoked with trailing text', { status: 403, body: { error: 'revoked ' } }]
    ])('%s → cache kept', (_name, outcome) => {
        expect(classifyResponse(outcome as never).clearCache).toBe(false)
    })

    it('reads sealed and degraded as unreachable, and takes the state from the header', () => {
        expect(classifyResponse({ status: 503, headers: { 'X-Vault-State': 'sealed' } })).toEqual({
            state: 'UNREACHABLE',
            code: 'vault_sealed',
            clearCache: false
        })
        expect(
            classifyResponse({ status: 503, headers: { 'x-vault-state': ['degraded'] }, body: { error: 'changed_during_read' } })
        ).toMatchObject({
            state: 'UNREACHABLE',
            code: 'changed_during_read'
        })
        expect(classifyResponse({ status: undefined })).toEqual({ state: 'UNREACHABLE', code: 'no_response', clearCache: false })
        expect(classifyResponse({ status: 504 })).toMatchObject({ state: 'UNREACHABLE', code: 'http_504' })
    })

    it('names the remaining states', () => {
        expect(classifyResponse({ status: 200, body: {} })).toMatchObject({ state: 'OK' })
        expect(classifyResponse({ status: 304 })).toMatchObject({ state: 'NOT_MODIFIED' })
        expect(classifyResponse({ status: 410, body: { error: 'tombstone' } })).toMatchObject({ state: 'TOMBSTONED', code: 'tombstone' })
        expect(classifyResponse({ status: 401, body: { error: 'clock_skew' } })).toMatchObject({
            state: 'REQUEST_REJECTED',
            code: 'clock_skew'
        })
        expect(classifyResponse({ status: 429 })).toMatchObject({ state: 'REQUEST_REJECTED', code: 'rate_limited' })
        expect(classifyResponse({ status: 501, body: { error: 'not_implemented' } })).toMatchObject({
            state: 'UNEXPECTED',
            code: 'not_implemented'
        })
        expect(classifyResponse({ status: 418 })).toMatchObject({ state: 'UNEXPECTED', code: 'http_418' })
    })

    it('never echoes an oversized or non-string error code', () => {
        expect(classifyResponse({ status: 403, body: { error: 'x'.repeat(65) } }).code).toBe('http_403')
        expect(classifyResponse({ status: 403, body: { error: 42 } }).code).toBe('http_403')
    })
})

describe('isVaultIdentity — wrong-service detection', () => {
    it('accepts exactly the identity document, in any key order', () => {
        expect(isVaultIdentity({ ...VAULT_IDENTITY })).toBe(true)
        expect(isVaultIdentity({ hub: 'coordinator-hub', api: 'v1', service: 'vault' })).toBe(true)
    })

    it.each([
        [{ service: 'vault', api: 'v1' }],
        [{ service: 'vault', api: 'v1', hub: 'coordinator-hub', extra: true }],
        [{ service: 'vault', api: 'v2', hub: 'coordinator-hub' }],
        [{ service: 'Vault', api: 'v1', hub: 'coordinator-hub' }],
        [{ service: 'vault', api: 'v1', hub: 'other-hub' }],
        [[VAULT_IDENTITY]],
        ['{"service":"vault","api":"v1","hub":"coordinator-hub"}'],
        [null],
        [undefined],
        [{}]
    ])('refuses %j', (body) => {
        expect(isVaultIdentity(body)).toBe(false)
    })
})

describe('parseBundle', () => {
    const valid = () => ({
        namespace: NS,
        etag: '"abc123"',
        items: [
            { path: `${NS}/master-key`, version: 3, data: { value: canary() }, type: 'api_key', mode: 'vault_owned', class: 'x' },
            { path: `${NS}/session-pepper`, version: 1, data: { value: canary() }, mode: 'mirrored' }
        ],
        tombstones: [{ path: `${NS}/old-key`, deleted: true, last_version: 2, reason: 'revoked' }],
        withheld: [{ path: `${NS}/admin-console`, reason: 'disclose_class', ui_path: '/ui/x' }]
    })

    it('reads a valid bundle', () => {
        const bundle = parseBundle(valid(), NS)
        expect(bundle.namespace).toBe(NS)
        expect(bundle.etag).toBe('"abc123"')
        expect(bundle.items.map((i) => [i.path, i.version])).toEqual([
            [`${NS}/master-key`, 3],
            [`${NS}/session-pepper`, 1]
        ])
        expect(bundle.tombstones).toEqual([{ path: `${NS}/old-key`, reason: 'revoked', lastVersion: 2 }])
        expect(bundle.withheld).toEqual([{ path: `${NS}/admin-console`, reason: 'disclose_class' }])
    })

    it('reads an empty but well-formed bundle', () => {
        expect(parseBundle({ namespace: NS, etag: 'e', items: [], tombstones: [], withheld: [] }, NS).items).toEqual([])
    })

    const broken: [string, (b: Record<string, any>) => unknown, string][] = [
        ['a string', () => 'bundle', 'malformed_bundle'],
        ['null', () => null, 'malformed_bundle'],
        ['an array', (b) => [b], 'malformed_bundle'],
        ['no etag', (b) => (delete b.etag, b), 'malformed_bundle'],
        ['no items', (b) => (delete b.items, b), 'malformed_bundle'],
        ['no tombstones', (b) => (delete b.tombstones, b), 'malformed_bundle'],
        ['no withheld', (b) => (delete b.withheld, b), 'malformed_bundle'],
        ['an empty etag', (b) => ((b.etag = ''), b), 'malformed_bundle'],
        ['items not an array', (b) => ((b.items = {}), b), 'malformed_bundle'],
        ['another namespace', (b) => ((b.namespace = 'coordinator-hub/services/other'), b), 'wrong_namespace'],
        ['an item with no path', (b) => (delete b.items[0].path, b), 'malformed_bundle'],
        ['an item path with a leading slash', (b) => ((b.items[0].path = `/${NS}/k`), b), 'malformed_bundle'],
        ['an item path with an empty segment', (b) => ((b.items[0].path = `${NS}//k`), b), 'malformed_bundle'],
        ['an item path with a control character', (b) => ((b.items[0].path = `${NS}/k\n`), b), 'malformed_bundle'],
        ['an item with version 0', (b) => ((b.items[0].version = 0), b), 'malformed_bundle'],
        ['an item with a string version', (b) => ((b.items[0].version = '3'), b), 'malformed_bundle'],
        ['an item whose data is a string', (b) => ((b.items[0].data = 'x'), b), 'malformed_bundle'],
        ['an item with no data', (b) => (delete b.items[0].data, b), 'malformed_bundle'],
        ['a tombstone without deleted:true', (b) => ((b.tombstones[0].deleted = false), b), 'malformed_bundle'],
        ['a withheld entry with an unknown reason', (b) => ((b.withheld[0].reason = 'because'), b), 'malformed_bundle'],
        ['the same path as an item twice', (b) => (b.items.push({ ...b.items[0] }), b), 'malformed_bundle'],
        ['a path that is both an item and a tombstone', (b) => ((b.tombstones[0].path = b.items[0].path), b), 'malformed_bundle'],
        ['a path that is both an item and withheld', (b) => ((b.withheld[0].path = b.items[1].path), b), 'malformed_bundle']
    ]

    it.each(broken)('refuses %s', (_name, mutate, reason) => {
        let thrown: unknown
        try {
            parseBundle(mutate(valid()), NS)
        } catch (error) {
            thrown = error
        }
        expect(thrown).toBeInstanceOf(VaultBundleError)
        expect((thrown as VaultBundleError).reason).toBe(reason)
    })

    it('never puts a value in a refusal', () => {
        const body = valid()
        const secret = body.items[0].data.value
        body.items.push({ ...body.items[0] })
        try {
            parseBundle(body, NS)
            throw new Error('expected a refusal')
        } catch (error) {
            expect(String((error as Error).message)).not.toContain(secret)
            expect(JSON.stringify(error)).not.toContain(secret)
        }
    })
})

describe('resolveSecret — fail closed', () => {
    const value = canary()
    const bundle: Bundle = {
        namespace: NS,
        etag: 'e',
        items: [
            { path: `${NS}/master-key`, version: 4, data: { value } },
            { path: `${NS}/structured`, version: 1, data: { username: 'u', password: canary() } },
            { path: `${NS}/empty`, version: 1, data: { value: '' } },
            { path: `${NS}/numeric`, version: 1, data: { value: 12345 } }
        ],
        tombstones: [{ path: `${NS}/deleted-one` }, { path: `${NS}/revoked-one`, reason: 'revoked' }],
        withheld: [
            { path: `${NS}/no-grant`, reason: 'no_read_grant' },
            { path: `${NS}/console`, reason: 'disclose_class' },
            { path: `${NS}/gone`, reason: 'not_found' }
        ]
    }
    const reasonFor = (path: string): string => {
        try {
            resolveSecret(bundle, path)
        } catch (error) {
            expect(error).toBeInstanceOf(VaultBundleError)
            expect((error as Error).message).not.toContain(value)
            return (error as VaultBundleError).reason
        }
        throw new Error(`expected '${path}' to be refused`)
    }

    it('returns the string value and version of a served secret', () => {
        expect(resolveSecret(bundle, `${NS}/master-key`)).toEqual({ path: `${NS}/master-key`, version: 4, value })
    })

    it.each([
        ['structured', 'not_a_string_secret'],
        ['empty', 'not_a_string_secret'],
        ['numeric', 'not_a_string_secret'],
        ['deleted-one', 'tombstoned'],
        ['revoked-one', 'revoked'],
        ['no-grant', 'withheld_no_read_grant'],
        ['console', 'withheld_disclose_class'],
        ['gone', 'withheld_not_found'],
        ['never-existed', 'absent'],
        ['MASTER-KEY', 'absent']
    ])('refuses %s as %s', (name, reason) => {
        expect(reasonFor(`${NS}/${name}`)).toBe(reason)
    })

    it('does not treat a path prefix or a look-alike as a match', () => {
        expect(reasonFor(`${NS}/master-key/`)).toBe('absent')
        expect(reasonFor(`${NS}/master`)).toBe('absent')
        expect(reasonFor('master-key')).toBe('absent')
    })
})
