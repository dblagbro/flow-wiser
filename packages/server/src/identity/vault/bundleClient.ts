/**
 * Coordinator Hub vault — one signed read of a namespace bundle.
 *
 * Glue between {@link signRequest} (how to ask) and {@link classifyResponse} / {@link parseBundle}
 * (what the answer means). It makes exactly one HTTP request and reports what happened; it holds no
 * state, keeps no cache, retries nothing and decides nothing about the keyring. Whoever calls it
 * owns those decisions (ADR-0006).
 *
 * What it will not do:
 *   - follow a redirect — a vault that redirects is not the vault that was configured, and a
 *     signature is bound to the authority it was made for;
 *   - read an unbounded body — the response is capped, and an oversized one is `UNEXPECTED`;
 *   - wait for ever — one timeout covers connecting and reading;
 *   - put a value, or any part of a response body, in an error or a log line.
 */
import http from 'node:http'
import https from 'node:https'
import { KeyObject } from 'node:crypto'
import { signRequest } from './requestSigner'
import { Bundle, Classification, classifyResponse, parseBundle, VaultBundleError } from './wire'

/** Bundles are small; anything near this is not a bundle. */
export const MAX_BUNDLE_BYTES = 1024 * 1024
export const DEFAULT_TIMEOUT_MS = 10_000

export interface FetchBundleInput {
    /** Where to connect, e.g. `http://127.0.0.1:18232` — may differ from `authority` behind a tunnel or proxy. */
    baseUrl: string
    /**
     * The hub's configured canonical authority — a bare `host[:port]`, no scheme (e.g.
     * `127.0.0.1:8232`). This exact string is signed and sent as `Host`.
     */
    authority: string
    /** API prefix, e.g. `/claudeCoordinator/api/v1/vault`. */
    prefix: string
    namespace: string
    /** Identity name enrolled on the hub. */
    keyid: string
    key: KeyObject | Buffer
    /** ETag from the last successful read; sent as `If-None-Match`. */
    etag?: string
    timeoutMs?: number
}

export type FetchBundleResult =
    | { outcome: 'bundle'; classification: Classification; bundle: Bundle }
    | { outcome: 'not_modified'; classification: Classification }
    /** The hub answered, or did not, and there is no bundle. `classification` says which and whether anything is cleared. */
    | { outcome: 'no_bundle'; classification: Classification }
    /** A 200 arrived but its body cannot be trusted. Never clears anything; never a partial bundle. */
    | { outcome: 'untrusted_bundle'; classification: Classification; reason: string }

const NAMESPACE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/

export const fetchBundle = async (input: FetchBundleInput): Promise<FetchBundleResult> => {
    // Dots are legal in a name, so `.` and `..` have to be excluded as whole segments: a namespace is
    // spliced into the request path, and `../` there asks for something other than what was configured.
    const segments = input.namespace.split('/')
    if (
        !NAMESPACE.test(input.namespace) ||
        input.namespace.length > 256 ||
        segments.some((segment) => segment === '.' || segment === '..')
    ) {
        throw new Error('vault namespace is not a valid path')
    }
    // A scheme, path or space here means the wrong thing was configured: the hub verifies against a
    // bare host[:port], so a signature over `http://host:port` is refused as unauthenticated — which
    // is exactly what the first live run against the hub's test listener showed.
    if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(input.authority) && !/^\[[0-9A-Fa-f:]+\](:\d{1,5})?$/.test(input.authority)) {
        throw new Error('vault authority must be a bare host[:port], without a scheme or path')
    }
    const base = new URL(input.baseUrl)
    if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('vault base URL must be http or https')

    const path = `${input.prefix.replace(/\/+$/, '')}/ns/${input.namespace}`
    const headers: Record<string, string> = {
        Accept: 'application/json',
        // The Host the hub expects is its own authority, not the tunnel or proxy we connect to.
        Host: input.authority,
        ...signRequest({ method: 'GET', authority: input.authority, path, keyid: input.keyid, key: input.key }),
        ...(input.etag ? { 'If-None-Match': input.etag } : {})
    }

    const response = await new Promise<{ status?: number; headers: http.IncomingHttpHeaders; body?: unknown; oversized?: boolean }>(
        (resolve) => {
            const transport = base.protocol === 'https:' ? https : http
            const request = transport.request(
                {
                    protocol: base.protocol,
                    hostname: base.hostname,
                    port: base.port || undefined,
                    method: 'GET',
                    path,
                    headers,
                    timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS
                },
                (res) => {
                    const chunks: Buffer[] = []
                    let size = 0
                    let oversized = false
                    res.on('data', (chunk: Buffer) => {
                        size += chunk.length
                        if (size > MAX_BUNDLE_BYTES) {
                            oversized = true
                            res.destroy()
                            return
                        }
                        chunks.push(chunk)
                    })
                    const finish = (): void => {
                        if (oversized) return resolve({ status: res.statusCode, headers: res.headers, oversized: true })
                        let body: unknown
                        try {
                            body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
                        } catch {
                            body = undefined
                        }
                        resolve({ status: res.statusCode, headers: res.headers, body })
                    }
                    res.on('end', finish)
                    res.on('close', finish)
                    res.on('error', () => resolve({ status: undefined, headers: {} }))
                }
            )
            request.on('timeout', () => request.destroy())
            request.on('error', () => resolve({ status: undefined, headers: {} }))
            request.end()
        }
    )

    if (response.oversized)
        return { outcome: 'no_bundle', classification: { state: 'UNEXPECTED', code: 'body_too_large', clearCache: false } }
    // A redirect is never followed and never a revoke.
    if (response.status !== undefined && response.status >= 300 && response.status < 400 && response.status !== 304) {
        return { outcome: 'no_bundle', classification: { state: 'UNEXPECTED', code: `http_${response.status}`, clearCache: false } }
    }

    const classification = classifyResponse({ status: response.status, headers: response.headers, body: response.body })
    if (classification.state === 'NOT_MODIFIED') return { outcome: 'not_modified', classification }
    if (classification.state !== 'OK') return { outcome: 'no_bundle', classification }

    try {
        return { outcome: 'bundle', classification, bundle: parseBundle(response.body, input.namespace) }
    } catch (error) {
        if (error instanceof VaultBundleError) return { outcome: 'untrusted_bundle', classification, reason: error.reason }
        throw error
    }
}
