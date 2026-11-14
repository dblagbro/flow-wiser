/**
 * RFC 9421 request signer for the Coordinator Hub vault — the client half of the hub's pinned
 * signature profile.
 *
 * A byte-exact port of the hub's reference signer (`coordinator-hub/app/vault_sig_client.py`,
 * `sign_headers`). "Byte-exact" is tested, not claimed: `requestSigner.test.ts` holds headers
 * produced by that Python reference and this module must reproduce them.
 *
 * The profile is strict, and the hub answers 401 to anything else:
 *
 *   - algorithm: ed25519 only;
 *   - covered components, in this order: "@method" "@authority" "@path", then "@query" when the
 *     request has a query string, then "content-digest" when it has a body — nothing else
 *     (in particular not "@target-uri");
 *   - parameters, in this order: created, keyid, alg, nonce, then expires when given;
 *   - `keyid` is the IDENTITY NAME the hub enrolled, not a key fingerprint;
 *   - `authority` is the value the HUB has configured as its canonical authority, not whatever Host
 *     header the HTTP client sends, and is lower-cased;
 *   - `path` is the full request path as sent, including any prefix.
 *
 * Pure: no network, no clock unless `created` is omitted, no key storage. The caller passes the
 * private key in; this module never reads one from disk or the environment and never logs.
 */
import { createHash, createPrivateKey, createPublicKey, KeyObject, randomBytes, sign } from 'node:crypto'

/** DER prefix that wraps a raw 32-byte Ed25519 seed as an unencrypted PKCS#8 private key. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

export interface SignRequestInput {
    method: string
    /** The hub's configured canonical authority, e.g. `http://127.0.0.1:8232`. */
    authority: string
    /** Full path as sent, prefix included. No query string. */
    path: string
    /** The identity name enrolled on the hub. */
    keyid: string
    /** An Ed25519 private key, or its raw 32-byte seed. */
    key: KeyObject | Buffer
    /** Query string WITHOUT the leading `?`. Empty or omitted when the request has none. */
    query?: string
    /** Request body. Empty or omitted when the request has none. */
    body?: Buffer | string
    /** Unix seconds. Defaults to now. */
    created?: number
    /** Defaults to a fresh random value; pass one only to reproduce a known answer. */
    nonce?: string
    /** Unix seconds. Omitted from the signature when not given. */
    expires?: number
    /** Signature label. Defaults to `sig1`. */
    label?: string
}

export interface SignedHeaders {
    'Signature-Input': string
    Signature: string
    /** Present only when the request has a body. */
    'Content-Digest'?: string
}

/** Wrap a raw seed, or check that a supplied key object really is Ed25519. */
export const toEd25519PrivateKey = (key: KeyObject | Buffer): KeyObject => {
    if (Buffer.isBuffer(key)) {
        if (key.length !== 32) throw new Error('an Ed25519 seed is exactly 32 bytes')
        return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, key]), format: 'der', type: 'pkcs8' })
    }
    if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 private key')
    return key
}

/** The raw 32-byte public key — what the hub enrols for an identity. Safe to share. */
export const publicKeyBytes = (key: KeyObject | Buffer): Buffer => {
    const spki = createPublicKey(toEd25519PrivateKey(key)).export({ format: 'der', type: 'spki' })
    return Buffer.from(spki.subarray(spki.length - 32))
}

/** RFC 9530 `Content-Digest` value for a body, as the hub computes it. */
export const contentDigest = (body: Buffer | string): string =>
    `sha-256=:${createHash('sha256')
        .update(typeof body === 'string' ? Buffer.from(body, 'utf8') : body)
        .digest('base64')}:`

/**
 * Headers to add to a request: `Signature-Input`, `Signature`, and `Content-Digest` when there is a
 * body.
 */
export const signRequest = (input: SignRequestInput): SignedHeaders => {
    const key = toEd25519PrivateKey(input.key)
    const created = Math.trunc(input.created ?? Date.now() / 1000)
    const nonce = input.nonce || randomBytes(16).toString('base64url')
    const label = input.label ?? 'sig1'
    const query = input.query ?? ''
    const body = input.body === undefined ? Buffer.alloc(0) : typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : input.body

    const components = ['@method', '@authority', '@path']
    if (query) components.push('@query')
    const digest = body.length > 0 ? contentDigest(body) : undefined
    if (digest) components.push('content-digest')

    let params = `created=${created};keyid="${input.keyid}";alg="ed25519";nonce="${nonce}"`
    if (input.expires !== undefined) params += `;expires=${Math.trunc(input.expires)}`
    const inner = `(${components.map((component) => `"${component}"`).join(' ')});${params}`

    const values: Record<string, string> = {
        '@method': input.method.toUpperCase(),
        '@authority': input.authority.toLowerCase(),
        '@path': input.path,
        '@query': `?${query}`,
        'content-digest': digest ?? ''
    }
    const base = [...components.map((component) => `"${component}": ${values[component]}`), `"@signature-params": ${inner}`].join('\n')
    const signature = sign(null, Buffer.from(base, 'utf8'), key).toString('base64')

    return {
        ...(digest ? { 'Content-Digest': digest } : {}),
        'Signature-Input': `${label}=${inner}`,
        Signature: `${label}=:${signature}:`
    }
}
