/**
 * Vault request signer — known answers from the hub's reference signer, and the profile's rules.
 *
 * The first block is the porting target. Each vector's headers were produced by the hub's own
 * `vault_sig_client.sign_headers` (Python, `cryptography`) on 2026-11-14; if this module reproduces
 * them byte for byte, a request signed here verifies on the hub. No private key is committed: each
 * vector's Ed25519 seed is SHA-256("FLOWWISER-VAULTSIG-KAT-KEY-" + label), derived at run time, and
 * is a test fixture that protects nothing.
 *
 * The second block checks the signature independently of the reference, by verifying it with
 * Node's own Ed25519 against a signature base rebuilt here from RFC 9421's rules.
 */
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { contentDigest, publicKeyBytes, signRequest, SignRequestInput, toEd25519PrivateKey } from './requestSigner'

const katSeed = (label: string): Buffer =>
    createHash('sha256')
        .update('FLOWWISER-VAULTSIG-KAT-KEY-' + label)
        .digest()

interface Vector {
    label: string
    method: string
    authority: string
    path: string
    query?: string
    body?: string
    created: number
    nonce: string
    expires?: number
    sigLabel?: string
    publicKeyHex: string
    headers: Record<string, string>
}

const VECTORS: Vector[] = [
    {
        label: 'get-bundle',
        method: 'GET',
        authority: 'http://127.0.0.1:8232',
        path: '/claudeCoordinator/api/v1/vault/ns/coordinator-hub/services/fixture-flowwiser',
        created: 1794630000,
        nonce: 'kat-nonce-0001',
        publicKeyHex: 'ceff0e5f8535d2a7f10a70330a6dedac95d9fec5d650dcb3aafb4c79438f3bd1',
        headers: {
            'Signature-Input':
                'sig1=("@method" "@authority" "@path");created=1794630000;keyid="fixture-flowwiser-reader";alg="ed25519";nonce="kat-nonce-0001"',
            Signature: 'sig1=:7/Z0xnKoNZFsSiSnT8P3OLQGDMuq6GEcrIeFk04M5IaIfsWO1fAaLQOweY+zjyAjw0/a8YJ38LnAOxnpBSxcDQ==:'
        }
    },
    {
        label: 'get-query',
        method: 'get',
        authority: 'HTTP://Hub.Example.TEST:8232',
        path: '/claudeCoordinator/api/v1/vault/audit',
        query: 'namespace=coordinator-hub/services/fixture-flowwiser&limit=5',
        created: 1794630001,
        nonce: 'kat-nonce-0002',
        publicKeyHex: 'e3310f5e41f170fdc2e7fa07f0986f77906bbfab3701b4c163fd7aa987c9957c',
        headers: {
            'Signature-Input':
                'sig1=("@method" "@authority" "@path" "@query");created=1794630001;keyid="fixture-flowwiser-reader";alg="ed25519";nonce="kat-nonce-0002"',
            Signature: 'sig1=:1LQDnXUOom8Tp93KYmv64A6+mk02xgalpwaFFaOswfvQ413CIL367x/axuiHe11d9o9n3D1Rp7BBLAc2zeGDCQ==:'
        }
    },
    {
        label: 'post-body',
        method: 'POST',
        authority: 'http://127.0.0.1:8232',
        path: '/claudeCoordinator/api/v1/vault/secrets/coordinator-hub/services/fixture-flowwiser/master-key/ack',
        body: '{"version":1,"phase":"applied"}',
        created: 1794630002,
        nonce: 'kat-nonce-0003',
        publicKeyHex: '34f09eb21a9cc1f3da026906a05f4cb56c7ced27e6309a0fc8e1bb8446febd69',
        headers: {
            'Content-Digest': 'sha-256=:iSbcVeecHomF1nmoUBoODFn2dqaclRSmgv6+SJIXmTI=:',
            'Signature-Input':
                'sig1=("@method" "@authority" "@path" "content-digest");created=1794630002;keyid="fixture-flowwiser-reader";alg="ed25519";nonce="kat-nonce-0003"',
            Signature: 'sig1=:dOI2fujzsQ1FU/V5rpRphmkw/U3fmnL7P0ahEavWEUD16PXq8iMUVLDm/IFnUgedirdc4O8LS0v/iYql4P3HBw==:'
        }
    },
    {
        label: 'post-body-expires-utf8',
        method: 'POST',
        authority: 'http://127.0.0.1:8232',
        path: '/claudeCoordinator/api/v1/vault/secrets/a/b/verify',
        query: 'x=1',
        body: '{"fingerprint":"caf\u00e9 \u2615"}',
        created: 1794630003,
        nonce: 'kat-nonce-0004',
        expires: 1794630303,
        sigLabel: 'sigX',
        publicKeyHex: 'bdff9c759f6285d97a01cf92156bda6077092d315a3796786d500afdf7dba39a',
        headers: {
            'Content-Digest': 'sha-256=:6p1yqI7G9rvm6Ns1avQnWEt3/NlTXoRCUER8Y2XjVfQ=:',
            'Signature-Input':
                'sigX=("@method" "@authority" "@path" "@query" "content-digest");created=1794630003;keyid="fixture-flowwiser-reader";alg="ed25519";nonce="kat-nonce-0004";expires=1794630303',
            Signature: 'sigX=:PtEiHWHGVaBn77oV8o9ObKoqK/rjTwO6sMHTB3Kc0Nma7bCY5DODo6PN7/OvSKQOYrv1OO+x8ZHhp4aMWQtWDg==:'
        }
    }
]

const inputFor = (v: Vector): SignRequestInput => ({
    method: v.method,
    authority: v.authority,
    path: v.path,
    keyid: 'fixture-flowwiser-reader',
    key: katSeed(v.label),
    query: v.query,
    body: v.body,
    created: v.created,
    nonce: v.nonce,
    expires: v.expires,
    label: v.sigLabel
})

/** Ed25519 SPKI DER prefix, to turn a raw 32-byte public key back into a key object. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const publicKeyFromRaw = (raw: Buffer) => createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' })

describe('signRequest — known answers from the hub reference signer', () => {
    it.each(VECTORS)('reproduces the reference headers for "$label"', (v) => {
        expect(signRequest(inputFor(v))).toEqual(v.headers)
    })

    it.each(VECTORS)('derives the same public key as the reference for "$label"', (v) => {
        expect(publicKeyBytes(katSeed(v.label)).toString('hex')).toBe(v.publicKeyHex)
    })

    it('covers a GET without query, a GET with query, a POST with body, and expires + a custom label', () => {
        const inputs = VECTORS.map((v) => v.headers['Signature-Input'])
        expect(inputs[0]).toContain('("@method" "@authority" "@path");')
        expect(inputs[1]).toContain('("@method" "@authority" "@path" "@query");')
        expect(inputs[2]).toContain('("@method" "@authority" "@path" "content-digest");')
        expect(inputs[3]).toMatch(/^sigX=\("@method" "@authority" "@path" "@query" "content-digest"\);.*;expires=\d+$/)
    })
})

describe('signRequest — the pinned profile', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const base: SignRequestInput = {
        method: 'get',
        authority: 'HTTP://Hub.TEST:8232',
        path: '/p/api/v1/vault/ns/a/b',
        keyid: 'some-identity',
        key: privateKey
    }

    /** Rebuild the RFC 9421 signature base from a request and its Signature-Input, independently. */
    const signatureBase = (input: SignRequestInput, headers: Record<string, string | undefined>): string => {
        const inner = (headers['Signature-Input'] as string).replace(/^[^=]+=/, '')
        const names = [...(/^\(([^)]*)\)/.exec(inner) as RegExpExecArray)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
        const value = (name: string): string =>
            ({
                '@method': input.method.toUpperCase(),
                '@authority': input.authority.toLowerCase(),
                '@path': input.path,
                '@query': `?${input.query ?? ''}`,
                'content-digest': headers['Content-Digest'] as string
            }[name] as string)
        return [...names.map((name) => `"${name}": ${value(name)}`), `"@signature-params": ${inner}`].join('\n')
    }
    const signatureOf = (headers: Record<string, string | undefined>): Buffer =>
        Buffer.from((/=:(.*):$/.exec(headers.Signature as string) as RegExpExecArray)[1], 'base64')

    it.each([
        ['no query, no body', {}],
        ['query', { query: 'namespace=a/b&limit=5' }],
        ['body', { method: 'POST', body: '{"version":1}' }],
        ['query and body', { method: 'POST', query: 'x=1', body: Buffer.from([0, 1, 2, 255]) }]
    ])('produces a signature that verifies against an independently built base: %s', (_name, extra) => {
        const input = { ...base, ...extra }
        const headers = signRequest(input) as unknown as Record<string, string | undefined>
        expect(verify(null, Buffer.from(signatureBase(input, headers), 'utf8'), publicKey, signatureOf(headers))).toBe(true)
    })

    it('a signature does not verify once the method, path, query or body is changed', () => {
        const input = { ...base, method: 'POST', query: 'x=1', body: '{"version":1}' }
        const headers = signRequest(input) as unknown as Record<string, string | undefined>
        const sig = signatureOf(headers)
        const tampered: [SignRequestInput, Record<string, string | undefined>][] = [
            [{ ...input, method: 'PUT' }, headers],
            [{ ...input, path: '/p/api/v1/vault/ns/a/c' }, headers],
            [{ ...input, query: 'x=2' }, headers],
            [input, { ...headers, 'Content-Digest': contentDigest('{"version":2}') }]
        ]
        for (const [changed, changedHeaders] of tampered) {
            expect(verify(null, Buffer.from(signatureBase(changed, changedHeaders), 'utf8'), publicKey, sig)).toBe(false)
        }
    })

    it('covers exactly the pinned components, in order, and never @target-uri', () => {
        const components = (headers: { 'Signature-Input': string }) =>
            (/\(([^)]*)\)/.exec(headers['Signature-Input']) as RegExpExecArray)[1]
        expect(components(signRequest(base))).toBe('"@method" "@authority" "@path"')
        expect(components(signRequest({ ...base, query: 'a=1' }))).toBe('"@method" "@authority" "@path" "@query"')
        expect(components(signRequest({ ...base, body: 'x' }))).toBe('"@method" "@authority" "@path" "content-digest"')
        expect(components(signRequest({ ...base, query: 'a=1', body: 'x' }))).toBe(
            '"@method" "@authority" "@path" "@query" "content-digest"'
        )
        expect(signRequest({ ...base, query: 'a=1', body: 'x' })['Signature-Input']).not.toContain('@target-uri')
    })

    it('orders the parameters created, keyid, alg, nonce, then expires', () => {
        expect(signRequest({ ...base, created: 100, nonce: 'n' })['Signature-Input']).toBe(
            'sig1=("@method" "@authority" "@path");created=100;keyid="some-identity";alg="ed25519";nonce="n"'
        )
        expect(signRequest({ ...base, created: 100, nonce: 'n', expires: 400 })['Signature-Input']).toMatch(/;nonce="n";expires=400$/)
    })

    it('sends Content-Digest only with a body, as sha-256 of the bytes', () => {
        expect(signRequest(base)).not.toHaveProperty('Content-Digest')
        expect(signRequest({ ...base, body: '' })).not.toHaveProperty('Content-Digest')
        expect(signRequest({ ...base, body: 'abc' })['Content-Digest']).toBe(
            `sha-256=:${createHash('sha256').update('abc').digest('base64')}:`
        )
        expect(contentDigest(Buffer.from('abc'))).toBe(contentDigest('abc'))
    })

    it('uses a fresh nonce and the current time unless told otherwise', () => {
        const a = signRequest(base)['Signature-Input']
        const b = signRequest(base)['Signature-Input']
        const nonce = (s: string) => (/nonce="([^"]+)"/.exec(s) as RegExpExecArray)[1]
        expect(nonce(a)).not.toBe(nonce(b))
        expect(nonce(a).length).toBeGreaterThanOrEqual(16)
        const created = Number((/created=(\d+)/.exec(a) as RegExpExecArray)[1])
        expect(Math.abs(created - Date.now() / 1000)).toBeLessThan(5)
    })

    it('accepts a raw 32-byte seed or an Ed25519 key object, and refuses anything else', () => {
        const seed = katSeed('seed-form')
        expect(signRequest({ ...base, key: seed, created: 1, nonce: 'n' })).toEqual(
            signRequest({ ...base, key: toEd25519PrivateKey(seed), created: 1, nonce: 'n' })
        )
        expect(() => signRequest({ ...base, key: Buffer.alloc(31) })).toThrow(/32 bytes/)
        expect(() => signRequest({ ...base, key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey })).toThrow(
            /not an Ed25519 private key/
        )
        expect(() => signRequest({ ...base, key: publicKey })).toThrow(/not an Ed25519 private key/)
    })

    it('exposes the raw public key, which round-trips to a verifying key', () => {
        const raw = publicKeyBytes(privateKey)
        expect(raw).toHaveLength(32)
        const headers = signRequest(base) as unknown as Record<string, string | undefined>
        expect(verify(null, Buffer.from(signatureBase(base, headers), 'utf8'), publicKeyFromRaw(raw), signatureOf(headers))).toBe(true)
    })
})
