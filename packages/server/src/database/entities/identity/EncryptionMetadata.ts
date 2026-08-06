/* eslint-disable */

/**
 * Identity — encryption-at-rest metadata convention (requirements §9).
 *
 * §9 requires "key rotation without re-entering every credential — re-encrypt in place, with a key
 * version recorded PER RECORD so rotation is resumable and auditable". A single global "current key
 * version" setting cannot deliver that: if the process dies half way through a re-encryption pass
 * there is no way to tell which rows were converted, and no way to audit which key a given
 * ciphertext was produced under. So the metadata travels with the row.
 *
 * ── The convention ───────────────────────────────────────────────────────────────────────────
 * Every column holding an AEAD ciphertext `X` is accompanied by four siblings:
 *
 *   `XKeyId`       opaque identifier of the key MATERIAL (which secret, e.g. a KMS key ARN, a
 *                  Vault path, or `env` for an env-injected key). Distinct from the version so a
 *                  deployment can migrate from a key file to a KMS key without renumbering.
 *   `XKeyVersion`  monotonically increasing integer, bumped on every rotation. Indexed: the
 *                  rotation pass is `WHERE X IS NOT NULL AND XKeyVersion < :current`, which is
 *                  resumable by construction — re-running it after a crash simply finds fewer rows.
 *   `XAlgorithm`   the AEAD construction the ciphertext was produced with. Recorded rather than
 *                  assumed so a future algorithm change is a rotation, not a flag day.
 *   `XNonce`       base64 per-record nonce/IV. §9: "unique nonce per record". Never reused; a
 *                  rotation writes a fresh one along with the new ciphertext.
 *
 * A fifth sibling `XSalt` is present where the key is DERIVED per record (§9: "per-credential
 * salt") rather than used directly — the salt is the KDF input that makes two records with the same
 * plaintext and the same master key produce unrelated ciphertexts.
 *
 * ── What is deliberately NOT here ────────────────────────────────────────────────────────────
 * The crypto itself. These entities model STORAGE only: no key loading, no derivation, no
 * encrypt/decrypt. That lives in the encryption service, so the schema does not have to change when
 * the key source does.
 *
 * ── Hashes are not encryption (§9) ───────────────────────────────────────────────────────────
 * Password hashes (`User.credential`), single-use token digests (`Token.tokenHash`) and MFA
 * recovery codes (`MfaRecoveryCode.codeHash`) carry NO metadata from this file. They are not
 * decryptable, there is no key to rotate, and giving them key-version columns would imply a
 * reversibility that must not exist.
 */

/** AEAD constructions permitted for encrypted-at-rest values (requirements §9) */
export enum EncryptionAlgorithm {
    /** Node's `crypto` provides this natively — no new runtime dependency */
    AES_256_GCM = 'aes-256-gcm',
    /** Permitted by §9; requires a library, so it is a configuration option rather than the default */
    XCHACHA20_POLY1305 = 'xchacha20-poly1305'
}

/**
 * Keyed digests — NOT encryption, and not interchangeable with {@link EncryptionAlgorithm}.
 *
 * Used where a value must be *verified* but never recovered, yet the verification is keyed by a
 * server-held secret (a "pepper") so that a stolen database alone cannot be brute-forced offline.
 * `Session.refreshTokenHash` is the case in point — see that column for why a keyed digest cannot
 * be re-keyed in place the way a ciphertext can.
 */
export enum KeyedDigestAlgorithm {
    HMAC_SHA256 = 'hmac-sha256'
}

/**
 * Length budget for a base64 nonce/salt column.
 *
 * 12 bytes (GCM) → 16 chars, 24 bytes (XChaCha20) → 32 chars, 32-byte KDF salt → 44 chars.
 * 64 leaves headroom for a longer construction without a migration.
 */
export const ENCRYPTION_NONCE_MAX_LENGTH = 64

/** Key identifiers are opaque strings — a KMS ARN is the longest realistic case */
export const ENCRYPTION_KEY_ID_MAX_LENGTH = 64
