import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { PUBLISHED_EXAMPLE_SECRETS } from './passwords'

/**
 * Key material loading, and the multi-version keyring that makes rotation possible.
 *
 * REQUIREMENTS-AUTH-RBAC.md §1 ("Credential encryption that survives host compromise") and §9
 * ("Encryption at rest") between them impose four hard rules, and this module exists to enforce
 * all four in one place:
 *
 *   1. **Refuse to start on any published example key value.** §1 records the actual failure mode:
 *      deployments run with `FLOWISE_SECRETKEY_OVERWRITE=myencryptionkey`, the value published in
 *      `packages/server/.env.example:25`, "making stored credentials trivially decryptable by
 *      anyone who reads the DB". A key on {@link PUBLISHED_EXAMPLE_SECRETS} is not a key.
 *   2. **The key must be able to live outside the host.** §9: "The current model keeps the key on
 *      the same filesystem as the database, so one file-read yields both." An env-injected secret
 *      is therefore the first-class source; a key file is supported but its permissions are
 *      enforced, not assumed.
 *   3. **Never generate silently.** The Apache-2.0 `getEncryptionKey()`
 *      (`packages/server/src/utils/index.ts:1553`) writes a fresh key when it cannot read one,
 *      which turns "the secret store was not mounted" into "every stored credential is now
 *      undecryptable garbage, and nobody noticed". We fail closed instead: no key, no start.
 *      This is the §2 rule ("fail closed: if the auth subsystem cannot initialise, refuse
 *      connections") applied to key loading.
 *   4. **Many keys, one active.** §9 requires "key rotation without re-entering every credential —
 *      re-encrypt in place, with a key version recorded per record". A rotation pass necessarily
 *      runs while rows still hold ciphertext under the OLD key, so decryption must stay possible
 *      for every retained version while encryption uses only the newest. Hence
 *      {@link Keyring.getActive} (write path) and {@link Keyring.getByVersion} (read path) are
 *      different methods rather than one "the key" accessor.
 *
 * ── What is NOT here ─────────────────────────────────────────────────────────────────────────
 * No encryption. This module hands out key MATERIAL; `aead.ts` derives a per-record key from it
 * with the record's salt and performs the AEAD. Keeping them apart is what lets a deployment move
 * from an env var to a KMS by adding a source here and changing nothing else — the
 * `keyId`/`keyVersion` pair recorded per row (see `EncryptionMetadata.ts`) is deliberately opaque
 * to the rest of the system.
 *
 * ── Configuration ────────────────────────────────────────────────────────────────────────────
 *   IDENTITY_ENCRYPTION_KEY                 active key material (base64, hex, or a raw passphrase)
 *   IDENTITY_ENCRYPTION_KEY_ID              opaque id recorded per row, default 'env'
 *   IDENTITY_ENCRYPTION_KEY_VERSION         version of the active key, default 1
 *   IDENTITY_ENCRYPTION_KEY_V<n>            retained key for DECRYPTION only, e.g. ..._V1
 *   IDENTITY_ENCRYPTION_KEY_V<n>_ID         its key id, default 'env'
 *   IDENTITY_ENCRYPTION_KEY_ACTIVE_VERSION  which version is active when only _V<n> vars are set
 *   IDENTITY_ENCRYPTION_KEY_FILE            path to a key file, used only when no env key is set
 *
 * A rotation is therefore: move the current value to `IDENTITY_ENCRYPTION_KEY_V<n>`, put the new
 * key in `IDENTITY_ENCRYPTION_KEY` with `IDENTITY_ENCRYPTION_KEY_VERSION=<n+1>`, restart, and run
 * the re-encryption pass. Old rows keep decrypting throughout, which is the "without downtime"
 * part; the per-row watermark is what makes the pass resumable.
 */

/** Where a key came from. Recorded for audit and for the operator-facing description — never the material. */
export enum KeySource {
    ENV = 'env',
    FILE = 'file'
}

/**
 * AES-256 needs a 256-bit key. Material shorter than this is refused rather than stretched: a
 * KDF cannot manufacture entropy that was never supplied, and accepting a short passphrase would
 * reintroduce exactly the weakness §1 is about.
 */
export const MIN_KEY_MATERIAL_BYTES = 32

/**
 * One version of the key.
 *
 * `material` is raw bytes and must never be logged, serialised, or returned from an API — §9:
 * "encrypted values never appear in logs, audit records, API responses, or error messages", and a
 * key is the value that makes all of them readable. {@link fingerprint} exists so operators can
 * still answer "is this the same key?" without the key.
 */
export interface KeyMaterial {
    /**
     * Opaque identifier of the key material, recorded per row as `XKeyId` (EncryptionMetadata.ts).
     * Distinct from the version so a deployment can migrate from a key file to a KMS key without
     * renumbering.
     */
    keyId: string
    /** Monotonic rotation counter, recorded per row as `XKeyVersion` */
    version: number
    /** Raw key bytes. Never log this. */
    material: Buffer
    source: KeySource
    /** First 16 hex chars of SHA-256 over the material — safe to log, useless to an attacker */
    fingerprint: string
}

/** The safe-to-log view of a keyring: which versions exist, where they came from, which one writes */
export interface KeyringDescription {
    activeVersion: number
    keys: { version: number; keyId: string; source: KeySource; fingerprint: string }[]
}

export interface Keyring {
    /** The key NEW ciphertext is produced under. Exactly one, always. */
    getActive(): KeyMaterial
    /** The key a stored row was encrypted under, selected by its recorded `XKeyVersion`. */
    getByVersion(version: number): KeyMaterial
    /** Every retained version, ascending. A rotation pass uses this to know what it may still read. */
    listVersions(): number[]
    /** Safe for logs and for an operator "encryption status" endpoint — contains no key material. */
    describe(): KeyringDescription
}

/**
 * Raised for every load failure. Startup treats this as fatal — REQUIREMENTS §2: "if the auth
 * subsystem cannot initialise, refuse connections rather than serving unauthenticated".
 *
 * Messages name the variable or path at fault, never the value read from it.
 */
export class KeyringError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'KeyringError'
    }
}

const DENYLIST = new Set(PUBLISHED_EXAMPLE_SECRETS.map((value) => value.toLowerCase()))

const fingerprintOf = (material: Buffer): string => createHash('sha256').update(material).digest('hex').slice(0, 16)

const isBase64 = (value: string): boolean => /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0
const isHex = (value: string): boolean => /^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0

/**
 * Turn configured text into key bytes.
 *
 * base64 and hex are decoded so that `openssl rand -base64 32` — the sane way to produce a key —
 * yields 32 bytes rather than 44 bytes of ASCII. Anything else is taken as a UTF-8 passphrase,
 * which is what the upstream `FLOWISE_SECRETKEY_OVERWRITE` convention produced, so an operator
 * migrating an existing (strong) key is not forced to re-encode it.
 *
 * The denylist is checked on the TEXT, before decoding: `myencryptionkey` is not valid base64, but
 * neither is it the only shape a published value can arrive in, so both the raw text and its
 * trimmed lower-cased form are tested.
 */
const materialFromText = (text: string, origin: string): Buffer => {
    const trimmed = text.trim()
    if (trimmed.length === 0) throw new KeyringError(`${origin} is empty — refusing to start (requirements §2, fail closed)`)

    if (DENYLIST.has(trimmed.toLowerCase())) {
        throw new KeyringError(
            `${origin} is set to a published example value — refusing to start (requirements §1). ` +
                'Generate a real key with: openssl rand -base64 32'
        )
    }

    let material: Buffer
    if (isHex(trimmed) && trimmed.length >= MIN_KEY_MATERIAL_BYTES * 2) {
        material = Buffer.from(trimmed, 'hex')
    } else if (isBase64(trimmed) && Buffer.from(trimmed, 'base64').length >= MIN_KEY_MATERIAL_BYTES) {
        material = Buffer.from(trimmed, 'base64')
    } else {
        material = Buffer.from(trimmed, 'utf8')
    }

    if (material.length < MIN_KEY_MATERIAL_BYTES) {
        throw new KeyringError(
            `${origin} supplies ${material.length} bytes of key material; at least ${MIN_KEY_MATERIAL_BYTES} are required ` +
                '(requirements §9, AES-256). Generate one with: openssl rand -base64 32'
        )
    }

    return material
}

const buildKey = (text: string, keyId: string, version: number, source: KeySource, origin: string): KeyMaterial => {
    if (!Number.isInteger(version) || version < 1) {
        throw new KeyringError(`${origin} declares key version '${version}'; versions are integers ≥ 1`)
    }
    const material = materialFromText(text, origin)
    return { keyId, version, material, source, fingerprint: fingerprintOf(material) }
}

/**
 * Permissions a key file may have: owner-read, optionally owner-write. Nothing else.
 *
 * §9 requires "a key file with enforced `0400`" — enforced, not documented, because a key file
 * readable by the application group is readable by every process in that group, and the whole
 * point of §9's threat model is an attacker who gets at the data without getting the process.
 * `0600` is permitted alongside `0400` so an operator can rotate the file in place without a
 * chmod dance; anything wider is a refusal, not a warning.
 */
const FORBIDDEN_FILE_MODE_BITS = 0o177

const readKeyFile = (path: string): string => {
    let mode: number
    try {
        mode = statSync(path).mode
    } catch (error) {
        throw new KeyringError(
            `IDENTITY_ENCRYPTION_KEY_FILE '${path}' cannot be read: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`
        )
    }

    // eslint-disable-next-line no-bitwise
    const offending = mode & FORBIDDEN_FILE_MODE_BITS
    if (offending !== 0) {
        throw new KeyringError(
            `IDENTITY_ENCRYPTION_KEY_FILE '${path}' has mode ${(mode & 0o777).toString(8).padStart(4, '0')}; ` +
                'it must be 0400 or 0600 (requirements §9). Fix with: chmod 0400 ' +
                path
        )
    }

    try {
        return readFileSync(path, 'utf8')
    } catch (error) {
        throw new KeyringError(
            `IDENTITY_ENCRYPTION_KEY_FILE '${path}' cannot be read: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`
        )
    }
}

/** Shape of a multi-key JSON key file. A file that is not JSON is treated as a single raw key. */
interface KeyFileEntry {
    version: number
    keyId?: string
    material: string
    active?: boolean
}

const keysFromFile = (path: string): { keys: KeyMaterial[]; activeVersion: number } => {
    const contents = readKeyFile(path)

    let parsed: unknown
    try {
        parsed = JSON.parse(contents)
    } catch {
        // Not JSON: the whole file is one key. This is the upstream `encryption.key` shape
        // (`packages/server/src/utils/index.ts:1580` reads the file as a single string), so an
        // existing deployment can point this variable at the file it already has.
        return { keys: [buildKey(contents, 'file', 1, KeySource.FILE, `key file '${path}'`)], activeVersion: 1 }
    }

    const entries = (parsed as { keys?: KeyFileEntry[] })?.keys
    if (!Array.isArray(entries) || entries.length === 0) {
        throw new KeyringError(`key file '${path}' is JSON but has no non-empty 'keys' array`)
    }

    const keys = entries.map((entry) =>
        buildKey(entry.material, entry.keyId ?? 'file', entry.version, KeySource.FILE, `key file '${path}' version ${entry.version}`)
    )
    const flagged = entries.filter((entry) => entry.active === true)
    if (flagged.length > 1) throw new KeyringError(`key file '${path}' marks ${flagged.length} keys active; exactly one may be active`)
    // No explicit flag: the highest version writes. Stated rather than inferred, so an operator who
    // adds a key without marking it cannot end up writing under a retired one.
    const activeVersion = flagged.length === 1 ? flagged[0].version : Math.max(...keys.map((key) => key.version))

    return { keys, activeVersion }
}

const RETIRED_KEY_VARIABLE = /^IDENTITY_ENCRYPTION_KEY_V(\d+)$/

const keysFromEnv = (env: NodeJS.ProcessEnv): { keys: KeyMaterial[]; activeVersion: number | null } => {
    const keys: KeyMaterial[] = []
    let activeVersion: number | null = null

    const primary = env.IDENTITY_ENCRYPTION_KEY
    if (primary !== undefined && primary.trim() !== '') {
        const version = env.IDENTITY_ENCRYPTION_KEY_VERSION ? Number.parseInt(env.IDENTITY_ENCRYPTION_KEY_VERSION, 10) : 1
        keys.push(buildKey(primary, env.IDENTITY_ENCRYPTION_KEY_ID ?? 'env', version, KeySource.ENV, 'IDENTITY_ENCRYPTION_KEY'))
        activeVersion = version
    }

    for (const name of Object.keys(env)) {
        const match = RETIRED_KEY_VARIABLE.exec(name)
        if (!match) continue
        const value = env[name]
        if (value === undefined || value.trim() === '') continue
        const version = Number.parseInt(match[1], 10)
        keys.push(buildKey(value, env[`${name}_ID`] ?? 'env', version, KeySource.ENV, name))
    }

    if (activeVersion === null && env.IDENTITY_ENCRYPTION_KEY_ACTIVE_VERSION) {
        activeVersion = Number.parseInt(env.IDENTITY_ENCRYPTION_KEY_ACTIVE_VERSION, 10)
    }
    // Only retired-style variables are set and none was nominated: the newest writes.
    if (activeVersion === null && keys.length > 0) activeVersion = Math.max(...keys.map((key) => key.version))

    return { keys, activeVersion }
}

class MapKeyring implements Keyring {
    private readonly byVersion: Map<number, KeyMaterial>
    private readonly activeVersion: number

    constructor(keys: KeyMaterial[], activeVersion: number) {
        this.byVersion = new Map()
        for (const key of keys) {
            const existing = this.byVersion.get(key.version)
            // Two different keys claiming one version would make `getByVersion` a coin toss and
            // could silently corrupt a rotation, so it is a startup failure rather than a
            // last-one-wins. Identical material declared twice is harmless and allowed.
            if (existing && !existing.material.equals(key.material)) {
                throw new KeyringError(`two different keys are declared for version ${key.version} — refusing to start`)
            }
            this.byVersion.set(key.version, key)
        }
        if (!this.byVersion.has(activeVersion)) {
            throw new KeyringError(
                `active key version ${activeVersion} has no material; declared versions are [${[...this.byVersion.keys()].join(', ')}]`
            )
        }
        this.activeVersion = activeVersion
    }

    getActive(): KeyMaterial {
        return this.byVersion.get(this.activeVersion) as KeyMaterial
    }

    getByVersion(version: number): KeyMaterial {
        const key = this.byVersion.get(version)
        if (!key) {
            // The row records a version this deployment cannot supply. Loud, and specific about
            // what is missing, because the remedy (restore the retired key to the environment) is
            // only obvious if the version number is in the message. Never a silent null.
            throw new KeyringError(
                `no key material for version ${version}; retained versions are [${this.listVersions().join(', ')}]. ` +
                    'A record encrypted under a discarded key cannot be recovered — restore the retired key to decrypt it.'
            )
        }
        return key
    }

    listVersions(): number[] {
        return [...this.byVersion.keys()].sort((a, b) => a - b)
    }

    describe(): KeyringDescription {
        return {
            activeVersion: this.activeVersion,
            keys: this.listVersions().map((version) => {
                const key = this.byVersion.get(version) as KeyMaterial
                return { version, keyId: key.keyId, source: key.source, fingerprint: key.fingerprint }
            })
        }
    }
}

/**
 * Build a keyring from configuration. Pure: it reads the env object it is given (and any key file
 * that names), holds no global state, and is what tests and the rotation CLI use directly.
 *
 * Source priority is env-then-file, per §9's "the key must be able to live outside the host": an
 * injected secret should win over anything sitting on the same disk as the database. Mixing the
 * two is refused rather than merged — a half-migrated configuration is how a deployment ends up
 * encrypting under a key it thought it had retired.
 *
 * @throws {KeyringError} when no source is configured, or any configured source is unusable.
 */
export const loadKeyring = (env: NodeJS.ProcessEnv = process.env): Keyring => {
    const fromEnv = keysFromEnv(env)
    const filePath = env.IDENTITY_ENCRYPTION_KEY_FILE

    if (fromEnv.keys.length > 0) {
        if (filePath) {
            throw new KeyringError(
                'both IDENTITY_ENCRYPTION_KEY* variables and IDENTITY_ENCRYPTION_KEY_FILE are set — ' +
                    'configure exactly one key source so it is unambiguous which key is active'
            )
        }
        return new MapKeyring(fromEnv.keys, fromEnv.activeVersion as number)
    }

    if (filePath) {
        const fromFile = keysFromFile(filePath)
        return new MapKeyring(fromFile.keys, fromFile.activeVersion)
    }

    // Fail closed. Note what is deliberately absent: a generate-on-miss branch.
    throw new KeyringError(
        'no encryption key configured — set IDENTITY_ENCRYPTION_KEY or IDENTITY_ENCRYPTION_KEY_FILE. ' +
            'A key is never generated automatically: silently inventing one would make every previously ' +
            'stored credential undecryptable (requirements §1, §9).'
    )
}

let cached: Keyring | null = null

/**
 * The process-wide keyring, loaded once.
 *
 * Cached because `aead.ts` asks for it on every encrypt and decrypt, and because a key that
 * changed under a running process would produce rows nobody can attribute to a version. Rotation
 * is a restart plus a re-encryption pass, not a live swap.
 */
export const getKeyring = (): Keyring => {
    if (!cached) cached = loadKeyring()
    return cached
}

/** Drop the cached keyring. For tests and for a CLI that loads several configurations in one process. */
export const resetKeyring = (): void => {
    cached = null
}
