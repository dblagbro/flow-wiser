import { decrypt as aeadDecrypt, encrypt as aeadEncrypt, EncryptionMetadataFields } from '../identity/crypto/aead'
import { getKeyring } from '../identity/crypto/keyring'

/**
 * Authenticated, versioned encryption for stored credentials.
 *
 * ── What this replaces, and why it mattered ──────────────────────────────────────────────────
 *
 * Credentials were encrypted with `crypto-js` AES using a single static passphrase:
 *
 *     AES.encrypt(JSON.stringify(plainDataObj), encryptKey).toString()
 *
 * Four problems, each independently disqualifying for any of SOC 2 CC6.1, the HIPAA Security Rule
 * §164.312(a)(2)(iv)/(e)(2)(ii), or PCI-DSS 3.5–3.6:
 *
 *  1. **No authentication.** CBC without a MAC is malleable — an attacker with write access to the
 *     database can alter ciphertext and the application cannot tell. AEAD makes tampering a
 *     decryption failure rather than a silent corruption.
 *  2. **Weak key derivation.** crypto-js derives the key from a passphrase with EVP_BytesToKey,
 *     which is MD5-based and unsalted across records. HKDF-SHA-256 with a per-record salt replaces
 *     it.
 *  3. **No key version on the record.** Rotation therefore required decrypting and re-encrypting
 *     every row in one pass, with no way to resume, no way to tell which rows had moved, and no way
 *     to run two keys during a migration. Every framework above asks for demonstrable key rotation;
 *     "we wrote a script once" is not that.
 *  4. **No algorithm agility.** The algorithm was implied by the code, so changing it would make
 *     existing data undecryptable with no way to detect which format a row used.
 *
 * ── Compatibility is the whole design constraint ─────────────────────────────────────────────
 *
 * Existing deployments hold rows in the legacy format, and this fork's core promise is that you can
 * upgrade without losing data. So:
 *
 *   - `decryptEnvelope` accepts BOTH formats and detects which it has from the payload itself.
 *   - `encryptEnvelope` always writes the new format.
 *   - A row therefore migrates the first time it is saved, and `credential:rotate-encryption`
 *     migrates the rest on demand.
 *
 * The envelope is self-describing JSON with a version tag rather than a delimited string, because a
 * delimiter has to be escaped out of base64 and someone eventually gets that wrong.
 */

/** Marks a payload as using the authenticated envelope. Legacy crypto-js output can never start with this. */
export const ENVELOPE_PREFIX = 'fwenc:v1:'

export interface CredentialEnvelope extends EncryptionMetadataFields {
    /** Base64 ciphertext produced by `identity/crypto/aead`. */
    c: string
}

/** True when the stored value uses the authenticated envelope rather than the legacy crypto-js format. */
export const isEnvelope = (stored: string | null | undefined): boolean => typeof stored === 'string' && stored.startsWith(ENVELOPE_PREFIX)

/**
 * Encrypt with AES-256-GCM, recording the key id, key version, algorithm, nonce and salt alongside
 * the ciphertext so the record can be decrypted after a rotation and re-encrypted incrementally.
 */
export const encryptEnvelope = (plaintext: string): string => {
    const result = aeadEncrypt(plaintext, getKeyring())
    const envelope: CredentialEnvelope = {
        c: result.ciphertext,
        keyId: result.keyId,
        keyVersion: result.keyVersion,
        algorithm: result.algorithm,
        nonce: result.nonce,
        salt: result.salt
    }
    return ENVELOPE_PREFIX + Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64')
}

/**
 * Decrypt an envelope. Throws on tampering — that is the point of using AEAD, and a caller must not
 * be able to mistake a modified record for a valid one.
 */
export const decryptEnvelope = (stored: string): string => {
    const raw = stored.slice(ENVELOPE_PREFIX.length)
    let envelope: CredentialEnvelope
    try {
        envelope = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
    } catch {
        throw new Error('Credential envelope is malformed and cannot be decrypted')
    }
    return aeadDecrypt(envelope.c, envelope, getKeyring())
}

/**
 * The key version a stored value was encrypted under, or null for a legacy record.
 *
 * This is what makes rotation resumable and auditable: an operator can count how many records are
 * still under a retired key without decrypting any of them.
 */
export const envelopeKeyVersion = (stored: string | null | undefined): number | null => {
    if (!isEnvelope(stored)) return null
    try {
        const parsed = JSON.parse(Buffer.from((stored as string).slice(ENVELOPE_PREFIX.length), 'base64').toString('utf8'))
        return typeof parsed.keyVersion === 'number' ? parsed.keyVersion : null
    } catch {
        return null
    }
}
