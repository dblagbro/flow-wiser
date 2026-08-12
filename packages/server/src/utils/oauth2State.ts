import { randomBytes } from 'crypto'

/**
 * Single-use, expiring `state` values for the OAuth2 authorisation handshake.
 *
 * ── What was wrong ───────────────────────────────────────────────────────────────────────────
 *
 * `state` was the credential's own UUID (`routes/oauth2/index.ts:146`, "Use credential ID as state
 * parameter"), and `/callback` resolved it with `findOneBy({ id: state })` — no ownership check, no
 * CSRF binding, no expiry, no single-use. `/callback` is in WHITELIST_URLS because an OAuth provider
 * redirects a browser to it, so the whole path was reachable unauthenticated.
 *
 * That is GHSA-wch5-xp77-fxg4. Anyone who knew a credential UUID could complete an authorisation
 * against their OWN provider account and have the resulting tokens written onto someone else's
 * credential — after which that tenant's flows act as the attacker's identity. The reverse is just
 * as bad: replaying a captured callback re-writes tokens at will.
 *
 * A `state` that is the identifier of the thing being modified is not a state parameter. Its entire
 * purpose in OAuth2 is to be unguessable and to bind the callback to the request that started it.
 *
 * ── What this does ───────────────────────────────────────────────────────────────────────────
 *
 * 128 bits from a CSPRNG, issued only by `/authorize` (which is authenticated and workspace-scoped),
 * remembered with the credential and workspace it was issued for, single-use, and expiring in ten
 * minutes — comfortably longer than a human consent screen, far shorter than a useful attack window.
 *
 * ── Known limitation, stated rather than hidden ──────────────────────────────────────────────
 *
 * In-process. A restart mid-handshake invalidates pending states (the user retries the connect),
 * and it does not span replicas. For a multi-replica deployment this belongs in the database or a
 * shared cache. It is not moved there now because doing so needs a migration and this fix is closing
 * a live unauthenticated credential-write hole; the tradeoff is recorded so it is a decision rather
 * than an oversight.
 */

interface PendingState {
    credentialId: string
    workspaceId: string
    expiresAt: number
}

const TTL_MS = 10 * 60 * 1000
const pending = new Map<string, PendingState>()

const sweep = (): void => {
    const now = Date.now()
    for (const [key, value] of pending) {
        if (value.expiresAt <= now) pending.delete(key)
    }
}

/** Issue a state for a handshake that `/authorize` has already authorised. */
export const issueOAuth2State = (credentialId: string, workspaceId: string): string => {
    sweep()
    const state = randomBytes(16).toString('hex')
    pending.set(state, { credentialId, workspaceId, expiresAt: Date.now() + TTL_MS })
    return state
}

/**
 * Redeem a state. Returns the credential/workspace it was issued for, or null.
 *
 * Deletes on read: a callback replayed with the same state fails, which is what makes this
 * single-use rather than merely unguessable.
 */
export const redeemOAuth2State = (state: string | undefined): { credentialId: string; workspaceId: string } | null => {
    if (!state) return null
    sweep()
    const found = pending.get(state)
    if (!found) return null
    pending.delete(state)
    if (found.expiresAt <= Date.now()) return null
    return { credentialId: found.credentialId, workspaceId: found.workspaceId }
}

/** Test seam only. */
export const _pendingOAuth2StateCount = (): number => pending.size
