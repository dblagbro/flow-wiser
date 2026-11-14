/**
 * Coordinator Hub vault — reading what the hub said.
 *
 * Two jobs, both pure (no network, no clock, no storage):
 *
 *  1. {@link classifyResponse} turns an HTTP outcome into one of the contract's wire states
 *     (hub ONBOARDING §5.1). The whole point of that table is one rule:
 *
 *         ONLY AN EXPLICIT `revoked` OR `grant_denied` CLEARS A CACHE.
 *
 *     A sealed vault, a proxy's error page, a timeout, a clock problem, a replayed nonce, a rate
 *     limit or a 501 is never a revoke. Getting that wrong in one direction keeps using a
 *     credential the operator withdrew; in the other, a restart of the hub makes every consumer
 *     throw away keys it still needs. So the decision is made here, once, and tested exhaustively,
 *     rather than re-derived by each caller from a status code.
 *
 *  2. {@link parseBundle} and {@link resolveSecret} read the namespace bundle (contract v1 §8).
 *     They fail closed: an entry that is withheld, tombstoned, malformed or absent is a refusal
 *     with a reason, never an empty value and never a guess.
 *
 * Nothing here ever puts a secret value in an error, a return value meant for logging, or a thrown
 * message. Errors name paths and reasons.
 */

/** The fixed identity document. Anything else behind the URL is the wrong service. */
export const VAULT_IDENTITY = Object.freeze({ service: 'vault', api: 'v1', hub: 'coordinator-hub' })

/** True only for exactly the identity document — same keys, same values, nothing extra. */
export const isVaultIdentity = (body: unknown): boolean => {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return false
    const record = body as Record<string, unknown>
    const keys = Object.keys(record).sort()
    const expected = Object.keys(VAULT_IDENTITY).sort()
    return (
        keys.length === expected.length &&
        expected.every((key, index) => keys[index] === key && record[key] === (VAULT_IDENTITY as Record<string, string>)[key])
    )
}

export type WireState =
    /** 200 — a body to read. */
    | 'OK'
    /** 304 — nothing changed since the ETag sent. */
    | 'NOT_MODIFIED'
    /** Timeout, connection failure, 502/504, or 503 (sealed or degraded). Keep the cache quietly. */
    | 'UNREACHABLE'
    /** The hub explicitly said `revoked`. Clear the cache, alert. */
    | 'REVOKED'
    /** The hub explicitly said `grant_denied`. Clear the cache, alert. */
    | 'DENIED'
    /** Signature, clock, nonce, rate-limit or upstream-verify trouble. Never clears the cache. */
    | 'REQUEST_REJECTED'
    /** 410 — this secret is tombstoned. Drop that one secret. */
    | 'TOMBSTONED'
    /** Anything else: an unexpected status, an unparseable body, a 501. Never clears the cache. */
    | 'UNEXPECTED'

export interface Classification {
    state: WireState
    /** The hub's machine code when it sent one, else a short description of what was seen. */
    code: string
    /** True for REVOKED and DENIED only. This is the single place that decision is made. */
    clearCache: boolean
}

export interface ResponseOutcome {
    /** HTTP status, or undefined when no response arrived (timeout, refused, DNS). */
    status?: number
    /** Response headers, any casing. */
    headers?: Record<string, string | string[] | undefined>
    /** Parsed JSON body when there was one and it parsed; otherwise undefined. */
    body?: unknown
}

const REQUEST_REJECTED_CODES = new Set([
    'signature_invalid',
    'clock_skew',
    'nonce_replay',
    'rate_limited',
    'upstream_verify_failed',
    'unauthenticated'
])

const errorCode = (body: unknown): string | undefined => {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined
    const code = (body as Record<string, unknown>).error
    return typeof code === 'string' && code.length > 0 && code.length <= 64 ? code : undefined
}

const header = (headers: ResponseOutcome['headers'], name: string): string | undefined => {
    if (!headers) return undefined
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === name) return Array.isArray(value) ? value[0] : value
    }
    return undefined
}

export const classifyResponse = (outcome: ResponseOutcome): Classification => {
    const keep = (state: WireState, code: string): Classification => ({ state, code, clearCache: false })
    const { status } = outcome

    if (status === undefined) return keep('UNREACHABLE', 'no_response')
    if (status === 200) return keep('OK', 'ok')
    if (status === 304) return keep('NOT_MODIFIED', 'not_modified')

    const code = errorCode(outcome.body)
    const vaultState = header(outcome.headers, 'x-vault-state')

    // Sealed and degraded are "down", whatever a proxy in between did to the status line — which is
    // why the hub sends the header at all.
    if (status === 502 || status === 503 || status === 504)
        return keep('UNREACHABLE', code ?? (vaultState ? `vault_${vaultState}` : `http_${status}`))

    // The only two outcomes that clear a cache, and only when the HUB said so in its own JSON
    // error body. A bare 401/403 — a proxy's login page, a WAF block — is not the hub speaking.
    if ((status === 401 || status === 403) && code === 'revoked') return { state: 'REVOKED', code, clearCache: true }
    if ((status === 401 || status === 403) && code === 'grant_denied') return { state: 'DENIED', code, clearCache: true }

    if (status === 410) return keep('TOMBSTONED', code ?? 'tombstone')
    if (code && (REQUEST_REJECTED_CODES.has(code) || status === 429)) return keep('REQUEST_REJECTED', code)
    if (status === 429) return keep('REQUEST_REJECTED', 'rate_limited')

    return keep('UNEXPECTED', code ?? `http_${status}`)
}

/** Raised for a bundle that cannot be trusted or a secret that cannot be served. Never carries a value. */
export class VaultBundleError extends Error {
    constructor(message: string, readonly reason: string) {
        super(message)
        this.name = 'VaultBundleError'
    }
}

export interface BundleItem {
    path: string
    version: number
    /** SECRET. The stored data object. Never log. */
    data: Record<string, unknown>
}

export type WithheldReason = 'no_read_grant' | 'disclose_class' | 'not_found' | 'unsupported_name'

export interface Bundle {
    namespace: string
    etag: string
    items: BundleItem[]
    tombstones: { path: string; reason?: string; lastVersion?: number }[]
    withheld: { path: string; reason: WithheldReason }[]
}

const WITHHELD_REASONS = new Set<string>(['no_read_grant', 'disclose_class', 'not_found', 'unsupported_name'])
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const isPath = (value: unknown): value is string =>
    typeof value === 'string' &&
    /^[A-Za-z0-9._/-]{1,256}$/.test(value) &&
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    !value.includes('//')
const malformed = (what: string): VaultBundleError => new VaultBundleError(`vault bundle is malformed: ${what}`, 'malformed_bundle')

/**
 * Validate a bundle body against contract v1 §8 and return it typed.
 *
 * Strict on purpose. A bundle is the thing the encryption key will be read out of; a body that is
 * nearly right is far more likely to be the wrong service, a truncated response or a proxy's JSON
 * than a hub that changed shape, and "use what we can parse" is how a half-read bundle becomes an
 * empty key.
 *
 * @param expectedNamespace the namespace that was asked for; a bundle for any other is refused.
 */
export const parseBundle = (body: unknown, expectedNamespace: string): Bundle => {
    if (!isRecord(body)) throw malformed('not a JSON object')
    for (const field of ['namespace', 'etag', 'items', 'tombstones', 'withheld']) {
        if (!(field in body)) throw malformed(`missing '${field}'`)
    }
    if (body.namespace !== expectedNamespace)
        throw new VaultBundleError('vault bundle is for a different namespace than the one requested', 'wrong_namespace')
    if (typeof body.etag !== 'string' || body.etag.length === 0) throw malformed("'etag' is not a non-empty string")
    if (!Array.isArray(body.items) || !Array.isArray(body.tombstones) || !Array.isArray(body.withheld)) {
        throw malformed("'items', 'tombstones' and 'withheld' must be arrays")
    }

    const seen = new Set<string>()
    const claim = (path: string): void => {
        if (seen.has(path)) throw malformed(`path '${path}' appears more than once`)
        seen.add(path)
    }

    const items = body.items.map((entry, index): BundleItem => {
        if (!isRecord(entry) || !isPath(entry.path)) throw malformed(`items[${index}] has no valid path`)
        if (!Number.isInteger(entry.version) || (entry.version as number) < 1) throw malformed(`item '${entry.path}' has no valid version`)
        if (!isRecord(entry.data)) throw malformed(`item '${entry.path}' has no data object`)
        claim(entry.path)
        return { path: entry.path, version: entry.version as number, data: entry.data }
    })

    const tombstones = body.tombstones.map((entry, index) => {
        if (!isRecord(entry) || !isPath(entry.path) || entry.deleted !== true) throw malformed(`tombstones[${index}] is not a tombstone`)
        claim(entry.path)
        return {
            path: entry.path,
            ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}),
            ...(Number.isInteger(entry.last_version) ? { lastVersion: entry.last_version as number } : {})
        }
    })

    const withheld = body.withheld.map((entry, index) => {
        if (!isRecord(entry) || typeof entry.path !== 'string' || entry.path.length === 0) throw malformed(`withheld[${index}] has no path`)
        if (typeof entry.reason !== 'string' || !WITHHELD_REASONS.has(entry.reason))
            throw malformed(`withheld entry '${entry.path}' has an unknown reason`)
        claim(entry.path)
        return { path: entry.path, reason: entry.reason as WithheldReason }
    })

    return { namespace: expectedNamespace, etag: body.etag, items, tombstones, withheld }
}

export interface ResolvedSecret {
    path: string
    version: number
    /** SECRET. Never log. */
    value: string
}

/**
 * The string value of one secret in a bundle, or a refusal that says why.
 *
 * A plain string secret is stored as `{"value": "<string>"}` (contract v1, C38 Q-B12). Anything
 * else under `data` is not a string secret and is refused rather than stringified.
 */
export const resolveSecret = (bundle: Bundle, path: string): ResolvedSecret => {
    const item = bundle.items.find((entry) => entry.path === path)
    if (item) {
        const value = item.data.value
        if (typeof value !== 'string' || value.length === 0) {
            throw new VaultBundleError(`vault secret '${path}' does not carry a non-empty string under data.value`, 'not_a_string_secret')
        }
        return { path, version: item.version, value }
    }

    const tombstone = bundle.tombstones.find((entry) => entry.path === path)
    if (tombstone)
        throw new VaultBundleError(
            `vault secret '${path}' is tombstoned (${tombstone.reason ?? 'deleted'})`,
            tombstone.reason === 'revoked' ? 'revoked' : 'tombstoned'
        )

    const held = bundle.withheld.find((entry) => entry.path === path)
    if (held) throw new VaultBundleError(`vault secret '${path}' is withheld (${held.reason})`, `withheld_${held.reason}`)

    throw new VaultBundleError(`vault secret '${path}' is not in the bundle for '${bundle.namespace}'`, 'absent')
}
