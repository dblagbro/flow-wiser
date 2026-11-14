/**
 * Resolve Express's `trust proxy` setting from `TRUST_PROXY` (SEC-B-09).
 *
 * ── Why the default is "trust nothing" ───────────────────────────────────────────────────────
 *
 * Express derives `req.ip` from `X-Forwarded-For` only as far as it has been told to trust the hops
 * that wrote it. The inherited default here was `true` — trust every hop — which means the header is
 * believed in full, and the header is written by the client. Anything keyed on `req.ip` then keys on
 * a value the caller chooses: the per-IP login limiter is bypassed by sending a different address on
 * each request, and the audit trail records whatever address the caller typed.
 *
 * There is no value that is both safe and correct for every deployment, because the server cannot
 * know how many proxies are in front of it:
 *
 *  - `1` is right behind exactly one reverse proxy and spoofable when exposed directly.
 *  - `false` is right when exposed directly and merely imprecise behind a proxy: every client shares
 *    the proxy's address, so per-IP limits are coarser, but nobody can choose their own address.
 *
 * Failing imprecise is recoverable and visible; failing spoofable is neither. So an unset value
 * trusts nothing, and says so once at boot, naming the setting to change.
 *
 * An explicit `true` is still honoured — an operator may have a reason — but it is the same
 * client-controlled configuration described above, so it is warned about rather than passed silently.
 */

export type TrustProxySetting = boolean | number | string

export interface TrustProxyResolution {
    /** The value to hand to `app.set('trust proxy', …)`. */
    setting: TrustProxySetting
    /** A line for the boot log when the operator should know about the choice. */
    warning?: string
}

export const TRUST_PROXY_UNSET_WARNING =
    'TRUST_PROXY is not set, so no proxy is trusted and X-Forwarded-For is ignored. ' +
    'If this server is behind a reverse proxy, every client will appear to share the proxy address: ' +
    'set TRUST_PROXY to the number of proxies in front of it (1 for a single nginx or load balancer).'

export const TRUST_PROXY_PERMISSIVE_WARNING =
    'TRUST_PROXY=true trusts every proxy hop, which makes X-Forwarded-For client-controlled: ' +
    'per-IP rate limits can be bypassed and logged addresses can be forged. ' +
    'Set it to the number of proxies in front of this server instead (1 for a single nginx or load balancer).'

export const resolveTrustProxy = (raw: string | undefined): TrustProxyResolution => {
    const value = (raw ?? '').trim()

    if (value === '') return { setting: false, warning: TRUST_PROXY_UNSET_WARNING }

    const lowered = value.toLowerCase()
    if (lowered === 'false') return { setting: false }
    if (lowered === 'true') return { setting: true, warning: TRUST_PROXY_PERMISSIVE_WARNING }

    // A hop count. `0` trusts nothing, which is what Express means by it too.
    if (/^\d+$/.test(value)) return { setting: Number(value) }

    // Named ranges and address lists (`loopback`, `10.0.0.0/8, 192.168.0.1`) — Express parses these.
    return { setting: value }
}
