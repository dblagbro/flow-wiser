/**
 * LE1 codec tests.
 *
 * The first block is the Hub's byte-exact porting target (R-L1): the shared KAT vectors, reproduced
 * with no raw key bytes in the repo — key and nonce are derived from the label by SHA-256, exactly
 * as the Hub reference specifies. If these pass, a value encrypted here decrypts under the shared
 * ring on any other project, which is the whole point of a cross-project envelope.
 *
 * The second block is the LOCALENC deliverable-2 matrix for a pure codec: T1 (encrypt) and T2
 * (round-trip clear -> encrypted -> clear, both directions, R-L15). Full-store T3-T8 belong to the
 * dual-store migration, not this unit. All keys here are throwaway fixtures; no real store is touched.
 */
import { createHash } from 'node:crypto'
import { le1Encrypt, le1Decrypt, le1Peek, isEncrypted, LE1DecryptionError, LE1_PREFIX } from './le1'

// Hub derivation (no raw key bytes committed): key = SHA256("LOCALENC-REF-KEY-"+label),
// nonce = SHA256("LOCALENC-REF-NONCE-"+label)[:12].
const katKey = (label: string): Buffer =>
    createHash('sha256')
        .update('LOCALENC-REF-KEY-' + label)
        .digest()
const katNonce = (label: string): Buffer =>
    createHash('sha256')
        .update('LOCALENC-REF-NONCE-' + label)
        .digest()
        .subarray(0, 12)

const VECTORS: Array<{ label: string; ptHex: string; envelope: string }> = [
    {
        label: 'empty',
        ptHex: '',
        envelope: 'LE1:ACJ7ImFsZyI6IkEyNTZHQ00iLCJraWQiOiJrMSIsInYiOjF9gpttiBFKuXfWhMtYWopB9QRzndcLRTjrkLFOFw'
    },
    {
        label: 'ascii',
        ptHex: '6c6f63616c656e63',
        envelope: 'LE1:ACJ7ImFsZyI6IkEyNTZHQ00iLCJraWQiOiJrMSIsInYiOjF9ZEALH7qZZ2jhUOFI9OH8FLSbcvEc6VwqQhWFtYC_KMCUhceQ'
    },
    {
        label: 'block16',
        ptHex: '30313233343536373839616263646566',
        envelope: 'LE1:ACJ7ImFsZyI6IkEyNTZHQ00iLCJraWQiOiJrMSIsInYiOjF9jHyRBJXUV2NRnR0c8rP82w25ol2tdtK-oQby777jdKr6L1YePZaiTldVmaI'
    }
]

describe('LE1 codec — Hub KAT vectors (byte-exact porting target, R-L1)', () => {
    it.each(VECTORS)('encrypts "$label" to the exact Hub envelope', ({ label, ptHex }) => {
        const envelope = VECTORS.find((x) => x.label === label)!.envelope
        const out = le1Encrypt(katKey(label), 'k1', Buffer.from(ptHex, 'hex'), katNonce(label))
        expect(out).toBe(envelope)
    })

    it.each(VECTORS)('decrypts the "$label" envelope back to the original plaintext', ({ label, ptHex, envelope }) => {
        const ring = { k1: katKey(label) }
        expect(le1Decrypt(ring, envelope).toString('hex')).toBe(ptHex)
    })

    it('every KAT header is canonical JSON {"alg":"A256GCM","kid":"k1","v":1}', () => {
        for (const { label, envelope } of VECTORS) {
            expect(le1Peek(envelope)).toEqual({ alg: 'A256GCM', kid: 'k1', v: 1 })
            expect(envelope.startsWith(LE1_PREFIX)).toBe(true)
            expect(label).toBeTruthy()
        }
    })
})

describe('LE1 — T1 (encrypt) and T2 (round-trip, both directions, R-L15)', () => {
    const key = createHash('sha256').update('throwaway-fixture-key-v1').digest()
    const ring = { k1: key }

    it('T1: a sensitive value is ciphertext at rest; a clear value is readable; behaviour matches off', () => {
        const enc = le1Encrypt(key, 'k1', Buffer.from('super-secret-token', 'utf8'))
        expect(isEncrypted(enc)).toBe(true)
        expect(enc.includes('super-secret-token')).toBe(false)
        // "feature off" / mixed table: a value with no prefix is returned unchanged.
        expect(isEncrypted('plaintext-field')).toBe(false)
        expect(le1Decrypt(ring, 'plaintext-field').toString('utf8')).toBe('plaintext-field')
    })

    it('T2: clear -> encrypted -> clear with no loss, forward and reverse, for every shape', () => {
        const samples = ['', 'a', 'localenc', 'unicode: café ☕ \u0000 🔐 end', 'x'.repeat(4096)]
        for (const sample of samples) {
            const pt = Buffer.from(sample, 'utf8')
            const forward = le1Encrypt(key, 'k1', pt) // clear -> encrypted
            expect(isEncrypted(forward)).toBe(true)
            const reverse = le1Decrypt(ring, forward) // encrypted -> clear
            expect(reverse.equals(pt)).toBe(true)
            expect(reverse.toString('utf8')).toBe(sample)
        }
    })

    it('a fresh random nonce is used per encryption (no (key,nonce) reuse)', () => {
        const a = le1Encrypt(key, 'k1', Buffer.from('same'))
        const b = le1Encrypt(key, 'k1', Buffer.from('same'))
        expect(a).not.toBe(b)
        expect(le1Decrypt(ring, a).toString('utf8')).toBe('same')
        expect(le1Decrypt(ring, b).toString('utf8')).toBe('same')
    })

    it('tampering the ciphertext fails authentication (no silent wrong value)', () => {
        const enc = le1Encrypt(key, 'k1', Buffer.from('authentic', 'utf8'))
        const raw = Buffer.from(enc.slice(LE1_PREFIX.length), 'base64url')
        raw[raw.length - 1] ^= 0x01 // flip a bit in the GCM tag
        const tampered = LE1_PREFIX + raw.toString('base64url')
        expect(() => le1Decrypt(ring, tampered)).toThrow(LE1DecryptionError)
    })

    it('an unknown key id is refused cleanly (lost-key shape, T5)', () => {
        const enc = le1Encrypt(key, 'k1', Buffer.from('x'))
        expect(() => le1Decrypt({ k2: key }, enc)).toThrow(LE1DecryptionError)
    })

    it('rejects a non-32-byte key and an unsupported alg', () => {
        expect(() => le1Encrypt(Buffer.alloc(16), 'k1', Buffer.from('x'))).toThrow()
        expect(() => le1Encrypt(key, 'k1', Buffer.from('x'), undefined, 'XC20P')).toThrow()
    })
})
