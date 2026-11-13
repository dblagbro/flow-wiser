/**
 * LE1 — the cross-project encryption-at-rest envelope for the LOCALENC workstream.
 *
 * This is Flow-Wiser's byte-exact port of the Coordinator Hub reference codec (R-L1), so that an
 * LE1 value written by any project decrypts with the shared key ring and the same key can later be
 * handed out by the vault. It aligns the existing identity AEAD ({@link ./aead}) to the shared wire
 * format rather than replacing it: `aead.ts` stays the physical column store; LE1 is the interop /
 * export envelope the Architect required (L-7 Q2).
 *
 * Wire format (one envelope for fields and files):
 *   "LE1:" + base64url_nopad( HLEN(2 bytes big-endian) || HEADER || NONCE(12) || CT||TAG )
 *   HEADER = canonical JSON {"alg","kid","v"} (sorted keys, separators ",",":" — no spaces), UTF-8.
 *           The header is the AES-GCM AAD: it is readable without a key (kid/alg/v are not secret)
 *           but is tamper-authenticated, so a reader always knows which key decrypts a value.
 *   NONCE  = 12 random bytes (A256GCM). CT||TAG = AES-256-GCM with the 16-byte tag appended.
 *
 * A value WITHOUT the "LE1:" prefix reads back as clear text — this is deliberate, so a store can
 * hold mixed clear/encrypted rows during the copy-only dual-store conversion (M6, T2).
 *
 * This module is pure codec. It never reads the master key, never touches a live store, and holds
 * no key material — callers pass keys in. The single future vault-transit swap (R25) belongs in a
 * separate `loadMasterKey()`, not here.
 *
 * Only A256GCM (AES-256-GCM) is implemented. The envelope reserves alg "XC20P"
 * (XChaCha20-Poly1305, 24-byte nonce) for Pi-class hosts; this build rejects it rather than
 * pretending to support it.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/** The marker that distinguishes an encrypted value from clear text in a mixed store. */
export const LE1_PREFIX = 'LE1:'
/** The only algorithm this build encrypts/decrypts. */
export const LE1_ALG = 'A256GCM'
/** A256GCM nonce length — the size GCM is specified and analysed for. */
export const LE1_NONCE_BYTES = 12
/** Full GCM tag; truncating it would weaken the exact property the envelope exists to provide. */
export const LE1_TAG_BYTES = 16
/** Envelope version, carried in the authenticated header. */
export const LE1_VERSION = 1

/** A GCM tag mismatch (wrong key or tampered value) is fatal and surfaces here, never a wrong value. */
export class LE1DecryptionError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'LE1DecryptionError'
    }
}

/** The authenticated, non-secret envelope header. */
export interface LE1Header {
    alg: string
    kid: string
    v: number
}

/** A key ring: key id -> 32-byte key. Retired keys are kept for decrypt-only. */
export type LE1Ring = Record<string, Buffer>

const b64uEncode = (b: Buffer): string => b.toString('base64url')
const b64uDecode = (s: string): Buffer => Buffer.from(s, 'base64url')

/**
 * Canonical JSON header, byte-identical to the Hub reference (`json.dumps(..., sort_keys=True,
 * separators=(",",":"))`). The keys alg < kid < v are already in sorted order, and `JSON.stringify`
 * emits no spaces, so the two encoders agree byte for byte.
 */
const encodeHeader = (kid: string, alg: string, v: number): Buffer => Buffer.from(JSON.stringify({ alg, kid, v }), 'utf8')

/** True if `v` is an LE1-encrypted value (as opposed to clear text left in place during conversion). */
export const isEncrypted = (v: unknown): v is string => typeof v === 'string' && v.startsWith(LE1_PREFIX)

/**
 * Encrypt plaintext to an LE1 envelope. `key` must be 32 bytes.
 *
 * `nonce` is optional and exists ONLY for known-answer tests: production callers must let it default
 * to a fresh random 12 bytes, because GCM security collapses if a (key, nonce) pair repeats.
 */
export function le1Encrypt(key: Buffer, kid: string, plaintext: Buffer, nonce?: Buffer, alg: string = LE1_ALG): string {
    if (key.length !== 32) throw new Error('LE1 requires a 32-byte key')
    if (alg !== LE1_ALG) throw new Error(`LE1 alg "${alg}" is not supported by this build (A256GCM only)`)
    const iv = nonce ?? randomBytes(LE1_NONCE_BYTES)
    if (iv.length !== LE1_NONCE_BYTES) throw new Error(`LE1 ${LE1_ALG} nonce must be ${LE1_NONCE_BYTES} bytes`)

    const header = encodeHeader(kid, alg, LE1_VERSION)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(header)
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const tag = cipher.getAuthTag()

    const hlen = Buffer.allocUnsafe(2)
    hlen.writeUInt16BE(header.length, 0)
    return LE1_PREFIX + b64uEncode(Buffer.concat([hlen, header, iv, ct, tag]))
}

/**
 * Decrypt an LE1 value with a key ring. A value without the LE1 prefix is returned as clear bytes,
 * so this is safe to call on every column of a mixed store during conversion.
 */
export function le1Decrypt(ring: LE1Ring, value: string | Buffer): Buffer {
    if (!isEncrypted(value)) return typeof value === 'string' ? Buffer.from(value, 'utf8') : value

    const raw = b64uDecode(value.slice(LE1_PREFIX.length))
    if (raw.length < 2) throw new LE1DecryptionError('LE1 value truncated before header length')
    const hlen = raw.readUInt16BE(0)
    const header = raw.subarray(2, 2 + hlen)
    if (header.length !== hlen) throw new LE1DecryptionError('LE1 header truncated')

    let meta: LE1Header
    try {
        meta = JSON.parse(header.toString('utf8'))
    } catch {
        throw new LE1DecryptionError('LE1 header is not valid JSON')
    }
    if (meta.alg !== LE1_ALG) throw new LE1DecryptionError(`LE1 alg "${meta.alg}" is not supported by this build`)

    const key = ring[meta.kid]
    if (!key) throw new LE1DecryptionError(`LE1 key id "${meta.kid}" is not in the ring`)

    const nonce = raw.subarray(2 + hlen, 2 + hlen + LE1_NONCE_BYTES)
    const body = raw.subarray(2 + hlen + LE1_NONCE_BYTES)
    if (nonce.length !== LE1_NONCE_BYTES || body.length < LE1_TAG_BYTES) {
        throw new LE1DecryptionError('LE1 value truncated before ciphertext')
    }
    const ct = body.subarray(0, body.length - LE1_TAG_BYTES)
    const tag = body.subarray(body.length - LE1_TAG_BYTES)

    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(header)
    decipher.setAuthTag(tag)
    try {
        return Buffer.concat([decipher.update(ct), decipher.final()])
    } catch {
        throw new LE1DecryptionError('LE1 authentication failed (wrong key or tampered value)')
    }
}

/** Read the authenticated header (kid/alg/v) of an LE1 value without a key. Not secret; do not trust until a decrypt succeeds. */
export function le1Peek(value: string): LE1Header {
    if (!isEncrypted(value)) throw new Error('not an LE1 value')
    const raw = b64uDecode(value.slice(LE1_PREFIX.length))
    const hlen = raw.readUInt16BE(0)
    return JSON.parse(raw.subarray(2, 2 + hlen).toString('utf8'))
}
