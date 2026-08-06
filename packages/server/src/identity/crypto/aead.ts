import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { EncryptionAlgorithm } from '../../database/entities/identity/EncryptionMetadata'
import { getKeyring, KeyMaterial, Keyring } from './keyring'

/**
 * Authenticated encryption for values stored at rest.
 *
 * REQUIREMENTS-AUTH-RBAC.md §9 names the fields this protects — "credentials, SSO client secrets,
 * MFA/TOTP seeds and recovery codes, API keys, session refresh secrets, and any flow node input
 * marked secret" — and the construction: "AEAD (AES-256-GCM or XChaCha20-Poly1305), unique nonce
 * per record, per-record salt".
 *
 * AES-256-GCM is what this module implements, because `node:crypto` provides it natively and no
 * new runtime dependency is permitted — the same reasoning already recorded on
 * `EncryptionMetadata.EncryptionAlgorithm.AES_256_GCM`. XChaCha20-Poly1305 stays in the enum, and
 * every ciphertext records which construction produced it, so adding it later is a rotation rather
 * than a flag day.
 *
 * ── Per-record key derivation ────────────────────────────────────────────────────────────────
 * The key from the keyring is never used to encrypt directly. Each record gets 32 random bytes of
 * salt, and the record key is HKDF-SHA256(master, salt, {@link HKDF_INFO}). That is §9's
 * "per-record salt", and it buys three things:
 *   - two records with the same plaintext under the same master key produce unrelated ciphertexts
 *     (already true of a random nonce, but the salt also decorrelates the KEYS, so a nonce-reuse
 *     bug cannot become a cross-record key-reuse catastrophe);
 *   - the master key may be a passphrase of arbitrary length — HKDF is what turns it into exactly
 *     32 uniform bytes;
 *   - the number of GCM encryptions under any single key stays near one, which keeps the
 *     birthday-bound argument against random 96-bit nonces irrelevant.
 *
 * ── Where the authentication tag lives ───────────────────────────────────────────────────────
 * `EncryptionMetadata.ts` defines exactly five siblings per ciphertext column — KeyId, KeyVersion,
 * Algorithm, Nonce, Salt. There is deliberately no tag column, so the 16-byte GCM tag is appended
 * to the ciphertext and travels inside the ciphertext column itself: the stored value is
 * base64(ciphertext ‖ tag). Splitting them across columns would let a partial write produce a
 * ciphertext with no tag, which is a ciphertext nobody can prove is intact.
 *
 * ── The metadata is authenticated, not merely recorded ───────────────────────────────────────
 * `keyId|keyVersion|algorithm` is passed to GCM as additional authenticated data. Without that, an
 * attacker with write access to the database could edit `XKeyVersion` and force the reader down a
 * different key path, or swap ciphertexts between rows. With it, any such edit fails the tag check
 * and surfaces as a {@link DecryptionError} instead of a silently wrong value. The nonce and salt
 * are not in the AAD because they are inputs to the computation — altering either already breaks
 * the tag.
 *
 * ── What this does NOT protect against ───────────────────────────────────────────────────────
 * §9 is explicit and this module inherits it verbatim: encryption at rest defends against "an
 * attacker who obtains the data without obtaining the running process". It does nothing against
 * code execution on the host, because the process must be able to decrypt in order to work.
 */

/** GCM's standard 96-bit nonce — the size the construction is specified and analysed for */
export const GCM_NONCE_BYTES = 12

/** 256-bit per-record KDF salt (§9: "per-record salt"). Fits the base64 budget in EncryptionMetadata.ts. */
export const KDF_SALT_BYTES = 32

/** Full-length GCM tag. Truncating it would weaken exactly the property this module exists to provide. */
export const GCM_TAG_BYTES = 16

/** AES-256 */
const DERIVED_KEY_BYTES = 32

/**
 * HKDF domain separation. Pinned and versioned: it is mixed into every derived key, so changing
 * this string invalidates every existing ciphertext. If a future construction needs a different
 * derivation, it gets a new algorithm value and a rotation — never a quiet edit here.
 */
export const HKDF_INFO = 'flow-wiser/identity/aead/aes-256-gcm/v1'

/**
 * The five per-record columns defined by `EncryptionMetadata.ts`, for a ciphertext column `X`:
 * `XKeyId`, `XKeyVersion`, `XAlgorithm`, `XNonce`, `XSalt`. Named without the prefix here so one
 * shape serves `User.credential`, `MfaFactor.secret`, `LoginMethod.clientSecret` and every future
 * encrypted column; the persistence layer maps these onto the prefixed columns.
 */
export interface EncryptionMetadataFields {
    keyId: string
    keyVersion: number
    algorithm: EncryptionAlgorithm
    /** base64 */
    nonce: string
    /** base64 */
    salt: string
}

/** A ciphertext together with everything needed to decrypt it later — i.e. one row's worth of columns */
export interface EncryptedValue extends EncryptionMetadataFields {
    /** base64 of (ciphertext ‖ 16-byte GCM tag) — see "Where the authentication tag lives" */
    ciphertext: string
}

/**
 * Raised for every decryption failure: a wrong or missing key, a corrupted or truncated value, a
 * tampered ciphertext, tampered metadata, or an algorithm this build cannot perform.
 *
 * There is no "return null on failure" path and no partial result. A GCM tag mismatch means the
 * plaintext is not authentic, and returning it anyway — or returning a fragment of it — would hand
 * the caller attacker-chosen data. The message never contains the ciphertext, the plaintext or any
 * key material (§9: "encrypted values never appear in ... error messages").
 */
export class DecryptionError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'DecryptionError'
    }
}

/** Raised when a caller hands us something that cannot be encrypted at all */
export class EncryptionError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'EncryptionError'
    }
}

/** HKDF-SHA256(master, per-record salt, pinned info) → 32 bytes. See "Per-record key derivation". */
const deriveRecordKey = (key: KeyMaterial, salt: Buffer): Buffer =>
    Buffer.from(hkdfSync('sha256', key.material, salt, HKDF_INFO, DERIVED_KEY_BYTES))

/** The additional authenticated data binding a ciphertext to the metadata stored beside it */
const associatedData = (meta: Pick<EncryptionMetadataFields, 'keyId' | 'keyVersion' | 'algorithm'>): Buffer =>
    Buffer.from(`${meta.keyId}|${meta.keyVersion}|${meta.algorithm}`, 'utf8')

/**
 * Encrypt `plaintext` under the keyring's ACTIVE key.
 *
 * Always the active key, never a caller-chosen version: new ciphertext under a retired key would
 * be invisible to the rotation pass, whose whole premise is
 * `WHERE X IS NOT NULL AND XKeyVersion < :current` (EncryptionMetadata.ts).
 *
 * Accepts a `Buffer` as well as a string so a caller holding raw secret bytes (a TOTP seed, for
 * instance) is not forced to round-trip them through a JS string, which cannot be zeroed.
 */
export const encrypt = (plaintext: string | Buffer, keyring: Keyring = getKeyring()): EncryptedValue => {
    if (typeof plaintext !== 'string' && !Buffer.isBuffer(plaintext)) throw new EncryptionError('plaintext must be a string or Buffer')

    const key = keyring.getActive()
    const salt = randomBytes(KDF_SALT_BYTES)
    // Unique per record, per §9, and freshly generated on every call — including a re-encryption,
    // so a rotation never rewrites a row with the nonce it already had.
    const nonce = randomBytes(GCM_NONCE_BYTES)
    const recordKey = deriveRecordKey(key, salt)

    const meta = {
        keyId: key.keyId,
        keyVersion: key.version,
        algorithm: EncryptionAlgorithm.AES_256_GCM
    }

    try {
        const cipher = createCipheriv('aes-256-gcm', recordKey, nonce, { authTagLength: GCM_TAG_BYTES })
        cipher.setAAD(associatedData(meta))
        const body = Buffer.concat([cipher.update(Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8')), cipher.final()])
        const tag = cipher.getAuthTag()

        return {
            ...meta,
            ciphertext: Buffer.concat([body, tag]).toString('base64'),
            nonce: nonce.toString('base64'),
            salt: salt.toString('base64')
        }
    } finally {
        // The derived key has served its purpose; do not leave it in the heap for a core dump or a
        // later heap snapshot to pick up. The master key in the keyring is a separate matter — it
        // has to stay resident, which is precisely why §9 says encryption at rest does not defend
        // against an attacker who owns the process.
        recordKey.fill(0)
    }
}

const decodeBase64 = (value: unknown, field: string, expectedBytes?: number): Buffer => {
    if (typeof value !== 'string' || value.length === 0) throw new DecryptionError(`${field} is missing or not a string`)
    const decoded = Buffer.from(value, 'base64')
    if (decoded.length === 0) throw new DecryptionError(`${field} is not valid base64`)
    if (expectedBytes !== undefined && decoded.length !== expectedBytes) {
        throw new DecryptionError(`${field} is ${decoded.length} bytes; ${expectedBytes} expected`)
    }
    return decoded
}

/**
 * Decrypt to raw bytes.
 *
 * The key is selected by `meta.keyVersion` — the per-record watermark — which is what allows a
 * rotation pass to run while rows under several versions coexist. A version the keyring cannot
 * supply raises {@link KeyringError} from the keyring itself, naming the missing version.
 */
export const decryptToBuffer = (ciphertext: string, meta: EncryptionMetadataFields, keyring: Keyring = getKeyring()): Buffer => {
    if (meta.algorithm !== EncryptionAlgorithm.AES_256_GCM) {
        // Recorded per row precisely so this can be detected rather than assumed. XChaCha20-Poly1305
        // is permitted by §9 but needs a library, so a row written by a build that had one cannot be
        // read by a build that does not — and saying so is far better than a tag mismatch nobody can
        // interpret.
        throw new DecryptionError(`algorithm '${meta.algorithm}' is recorded on this record but is not supported by this build`)
    }

    const key = keyring.getByVersion(meta.keyVersion)
    const nonce = decodeBase64(meta.nonce, 'nonce', GCM_NONCE_BYTES)
    const salt = decodeBase64(meta.salt, 'salt')
    const raw = decodeBase64(ciphertext, 'ciphertext')

    if (raw.length < GCM_TAG_BYTES) throw new DecryptionError('ciphertext is shorter than the authentication tag — the value is truncated')

    const body = raw.subarray(0, raw.length - GCM_TAG_BYTES)
    const tag = raw.subarray(raw.length - GCM_TAG_BYTES)
    const recordKey = deriveRecordKey(key, salt)

    try {
        const decipher = createDecipheriv('aes-256-gcm', recordKey, nonce, { authTagLength: GCM_TAG_BYTES })
        decipher.setAAD(associatedData(meta))
        decipher.setAuthTag(tag)
        const head = decipher.update(body)
        // `final()` is where GCM verifies the tag. Anything it throws — a tampered byte, the wrong
        // key, altered metadata — becomes a DecryptionError. `update()`'s output is discarded with
        // it: unverified plaintext must never leave this function.
        const tail = decipher.final()
        return Buffer.concat([head, tail])
    } catch (error) {
        throw new DecryptionError(
            'authentication failed — the value was encrypted under a different key, or the ciphertext or its metadata was modified'
        )
    } finally {
        recordKey.fill(0)
    }
}

/** Decrypt to a UTF-8 string — the common case, since every encrypted column in the identity schema is textual */
export const decrypt = (ciphertext: string, meta: EncryptionMetadataFields, keyring: Keyring = getKeyring()): string =>
    decryptToBuffer(ciphertext, meta, keyring).toString('utf8')

/**
 * Re-encrypt an existing value under the ACTIVE key — the engine of §9's "key rotation without
 * re-entering every credential".
 *
 * Decrypts with the version recorded on the record and re-encrypts with the current one, so the
 * operator never sees or re-enters the secret. The result carries a fresh nonce and a fresh salt,
 * not just a new key version: reusing either across a rotation would leak the relationship between
 * the old and new rows.
 *
 * The rotation pass is `WHERE X IS NOT NULL AND XKeyVersion < :current`, and it is resumable by
 * construction — the row's watermark only advances when the new ciphertext and its metadata are
 * committed together, so a crash mid-pass simply leaves fewer rows for the next run
 * (EncryptionMetadata.ts). Callers MUST write all six values in one transaction; writing the
 * ciphertext without its metadata produces a row nobody can decrypt.
 *
 * A record already on the active version is still re-encrypted rather than skipped, so this is
 * also the primitive for "re-key everything" after a suspected exposure. Skipping is the caller's
 * decision, and the `WHERE` clause above expresses it.
 */
export const reencrypt = (ciphertext: string, meta: EncryptionMetadataFields, keyring: Keyring = getKeyring()): EncryptedValue => {
    const plaintext = decryptToBuffer(ciphertext, meta, keyring)
    try {
        return encrypt(plaintext, keyring)
    } finally {
        plaintext.fill(0)
    }
}
