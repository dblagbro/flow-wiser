/**
 * Boot-time fetch of the master key and session pepper from the Coordinator Hub vault
 * (ADR-0006; rulings C42 and C45).
 *
 * Off unless `IDENTITY_KEY_SOURCE=vault`. With any other value this module does nothing and reads
 * no vault configuration, so turning the vault on is always a deliberate act.
 *
 * ── The rule this implements: Phase 1 is NO-LOCKOUT ──────────────────────────────────────────
 *
 * While the vault itself is still being proven, nothing it says or fails to say may stop this
 * server from booting on the key it already has. So, with the flag on:
 *
 *   vault serves both secrets, and they are usable   → use them
 *   anything else at all                             → do not use the vault this run; the caller
 *                                                      continues with the environment/file source
 *
 * "Anything else" is reported with a severity, because the cases are not equally alarming:
 *
 *   `alarm`    the hub explicitly said `revoked` or `grant_denied`; an entry is tombstoned or
 *              withheld; the bundle cannot be trusted; the vault's value is not the key this
 *              deployment already uses; the vault is misconfigured here
 *   `warning`  the vault is unreachable, sealed or degraded, or rejected the request for a
 *              reason that is about the request (clock, signature, rate limit)
 *
 * The one exception is opt-in: `IDENTITY_VAULT_STRICT_REVOKE=true` makes an explicit revoke or
 * denial refuse to start. It is for after the vault is trusted, and it is off by default.
 *
 * Nothing here weakens the existing floor. If the vault is not used and no environment/file key
 * is configured, the keyring refuses to start exactly as it always has. Never a generated key, and
 * never one secret from the vault with the other from the environment.
 *
 * ── Mirror, not rotate ───────────────────────────────────────────────────────────────────────
 *
 * The vault serves the key the deployment ALREADY uses. When an environment key is also present,
 * the two are compared by fingerprint; if they differ the vault's value is refused (`key_mismatch`),
 * because installing it would make every stored credential undecryptable. That check is what makes
 * "the first vault boot is not a rotation" something the code enforces instead of assumes.
 *
 * No secret value appears in anything this module returns, throws or logs.
 */
import { createPrivateKey, KeyObject } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { buildVaultKeyring, Keyring, KeyringError, loadKeyring } from '../crypto/keyring'
import { SessionPepperProvider, VaultSessionPepperProvider } from '../services/SessionService'
import { fetchBundle, FetchBundleInput, FetchBundleResult } from './bundleClient'
import { resolveSecret, VaultBundleError } from './wire'

export type VaultBootResult =
    /** `IDENTITY_KEY_SOURCE` is not `vault`. Nothing was read or attempted. */
    | { status: 'disabled' }
    /** Both secrets came from the vault and passed every check. */
    | { status: 'vault'; keyring: Keyring; pepperProvider: SessionPepperProvider; namespace: string }
    /** The vault is not used this run. `code` and `detail` are safe to log. */
    | { status: 'fallback'; severity: 'alarm' | 'warning'; code: string; detail: string }

/** Raised only in strict mode, for an explicit revoke or denial. */
export class VaultRevokedError extends Error {
    constructor(message: string, readonly code: string) {
        super(message)
        this.name = 'VaultRevokedError'
    }
}

export interface VaultBootDeps {
    fetchBundle?: (input: FetchBundleInput) => Promise<FetchBundleResult>
    /** Reads and validates the identity's private key. Injectable for tests. */
    loadIdentityKey?: (path: string) => KeyObject
}

const DEFAULT_PREFIX = '/claudeCoordinator/api/v1/vault'
const FORBIDDEN_FILE_MODE_BITS = 0o177

/** The identity key gets the same treatment as a key file: owner-only, or it is not read. */
export const loadIdentityKeyFile = (path: string): KeyObject => {
    const mode = statSync(path).mode
    // eslint-disable-next-line no-bitwise
    if ((mode & FORBIDDEN_FILE_MODE_BITS) !== 0) {
        // eslint-disable-next-line no-bitwise
        throw new Error(`identity key file has mode ${(mode & 0o777).toString(8).padStart(4, '0')}; it must be 0400 or 0600`)
    }
    const key = createPrivateKey(readFileSync(path))
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('identity key file is not an Ed25519 private key')
    return key
}

const isTrue = (value: string | undefined): boolean => (value ?? '').trim().toLowerCase() === 'true'

export const resolveVaultBootSecrets = async (env: NodeJS.ProcessEnv = process.env, deps: VaultBootDeps = {}): Promise<VaultBootResult> => {
    if ((env.IDENTITY_KEY_SOURCE ?? '').trim().toLowerCase() !== 'vault') return { status: 'disabled' }

    const alarm = (code: string, detail: string): VaultBootResult => ({ status: 'fallback', severity: 'alarm', code, detail })
    const warning = (code: string, detail: string): VaultBootResult => ({ status: 'fallback', severity: 'warning', code, detail })
    const strict = isTrue(env.IDENTITY_VAULT_STRICT_REVOKE)
    const revoked = (code: string, detail: string): VaultBootResult => {
        if (strict)
            throw new VaultRevokedError(
                `the vault answered ${code} (${detail}) and IDENTITY_VAULT_STRICT_REVOKE is set — refusing to start`,
                code
            )
        return alarm(code, detail)
    }

    const required = [
        'IDENTITY_VAULT_URL',
        'IDENTITY_VAULT_AUTHORITY',
        'IDENTITY_VAULT_NAMESPACE',
        'IDENTITY_VAULT_IDENTITY',
        'IDENTITY_VAULT_IDENTITY_KEY_FILE'
    ]
    const missing = required.filter((name) => !(env[name] ?? '').trim())
    if (missing.length > 0)
        return alarm(
            'vault_misconfigured',
            `IDENTITY_KEY_SOURCE=vault but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set`
        )

    const namespace = (env.IDENTITY_VAULT_NAMESPACE as string).trim()
    const masterPath = `${namespace}/${(env.IDENTITY_VAULT_MASTER_KEY_ENTRY ?? 'master-key').trim()}`
    const pepperPath = `${namespace}/${(env.IDENTITY_VAULT_SESSION_PEPPER_ENTRY ?? 'session-pepper').trim()}`

    let key: KeyObject
    try {
        key = (deps.loadIdentityKey ?? loadIdentityKeyFile)((env.IDENTITY_VAULT_IDENTITY_KEY_FILE as string).trim())
    } catch (error) {
        return alarm(
            'identity_key_unusable',
            error instanceof Error ? error.message.replace(/\s+/g, ' ').slice(0, 160) : 'could not be read'
        )
    }

    const timeout = Number.parseInt(env.IDENTITY_VAULT_TIMEOUT_MS ?? '', 10)
    let result: FetchBundleResult
    try {
        result = await (deps.fetchBundle ?? fetchBundle)({
            baseUrl: (env.IDENTITY_VAULT_URL as string).trim(),
            authority: (env.IDENTITY_VAULT_AUTHORITY as string).trim(),
            prefix: (env.IDENTITY_VAULT_PREFIX ?? DEFAULT_PREFIX).trim(),
            namespace,
            keyid: (env.IDENTITY_VAULT_IDENTITY as string).trim(),
            key,
            ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {})
        })
    } catch (error) {
        // fetchBundle throws only for configuration it refuses before sending anything.
        return alarm('vault_misconfigured', error instanceof Error ? error.message.slice(0, 160) : 'request could not be built')
    }

    if (result.outcome === 'untrusted_bundle') return alarm('untrusted_bundle', result.reason)
    if (result.outcome === 'not_modified') return alarm('unexpected_not_modified', 'a 304 was returned although no ETag was sent')
    if (result.outcome === 'no_bundle') {
        const { state, code } = result.classification
        if (state === 'REVOKED' || state === 'DENIED') return revoked(code, `namespace ${namespace}`)
        if (state === 'UNREACHABLE' || state === 'REQUEST_REJECTED')
            return warning(code, `${state.toLowerCase()} reading namespace ${namespace}`)
        return alarm(code, `${state.toLowerCase()} reading namespace ${namespace}`)
    }

    let masterText: string
    let pepperText: string
    try {
        masterText = resolveSecret(result.bundle, masterPath).value
        pepperText = resolveSecret(result.bundle, pepperPath).value
    } catch (error) {
        if (!(error instanceof VaultBundleError)) throw error
        const entry = error.message.includes(`'${masterPath}'`) ? masterPath : pepperPath
        return error.reason === 'revoked' ? revoked('revoked', `entry ${entry}`) : alarm(error.reason, `entry ${entry}`)
    }

    let keyring: Keyring
    try {
        keyring = buildVaultKeyring(masterText, env)
    } catch (error) {
        if (!(error instanceof KeyringError)) throw error
        // KeyringError messages name the origin and the rule broken, never the material.
        return alarm('vault_key_rejected', error.message.slice(0, 200))
    }

    // Mirror, not rotate: where the deployment still has its own key, the vault's must be the same key.
    let envKeyring: Keyring | undefined
    try {
        envKeyring = loadKeyring(env)
    } catch {
        envKeyring = undefined // no environment/file key configured: nothing to compare against
    }
    if (envKeyring) {
        const mine = envKeyring.getActive()
        const theirs = keyring.getActive()
        if (mine.version !== theirs.version || mine.fingerprint !== theirs.fingerprint) {
            return alarm(
                'key_mismatch',
                `the vault master key is not the configured key (v${mine.version}:${mine.fingerprint} here, v${theirs.version}:${theirs.fingerprint} from the vault)`
            )
        }
    }

    const parsedPepperVersion = Number.parseInt(env.FLOWISE_SESSION_PEPPER_VERSION ?? '1', 10)
    const pepperVersion = Number.isFinite(parsedPepperVersion) && parsedPepperVersion > 0 ? parsedPepperVersion : 1
    const pepperSecret = Buffer.from(pepperText, 'utf-8')
    // Same rule for the pepper: where one is still configured here, the vault's must be the same one.
    if (env.FLOWISE_SESSION_PEPPER && !Buffer.from(env.FLOWISE_SESSION_PEPPER, 'utf-8').equals(pepperSecret)) {
        return alarm('pepper_mismatch', 'the vault session pepper is not the configured pepper')
    }

    return {
        status: 'vault',
        keyring,
        pepperProvider: new VaultSessionPepperProvider(pepperSecret, pepperVersion, env.FLOWISE_SESSION_PEPPER_ID ?? 'session-pepper'),
        namespace
    }
}
