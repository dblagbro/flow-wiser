import logger from '../../utils/logger'
import { KeyringError, loadKeyring, resetKeyring } from '../crypto/keyring'
import { EnvSessionPepperProvider } from '../services/SessionService'

/**
 * Boot-time validation of the identity layer's key material.
 *
 * CALL SITE: `packages/server/src/index.ts:111`, inside `App.initDatabase()`:
 *
 *     await initAuthSecrets()
 *     logger.info('🔐 [server]: Auth initialized successfully')
 *
 * Awaited, return value discarded, and the caller logs its own success line. That fixes the
 * contract completely: `() => Promise<void>`, called once, before the HTTP server is configured.
 *
 * ── What it actually does, and why it is not a no-op ─────────────────────────────────────────
 *
 * Two independent secrets have to exist before a single request can be served:
 *
 *   IDENTITY_ENCRYPTION_KEY   the AEAD keyring (crypto/keyring.ts) — protects stored secrets
 *   FLOWISE_SESSION_PEPPER    the session pepper (SessionService) — protects refresh-token digests
 *
 * Both are lazy: the keyring loads on first `encrypt`/`decrypt`, and the pepper is read on first
 * `issue`. Left alone, a deployment that forgot either one starts cleanly, serves the sign-in page,
 * and fails at the moment the first user tries to log in — with a stack trace, in a request path,
 * long after the operator stopped watching the boot log.
 *
 * REQUIREMENTS-AUTH-RBAC §2 says the opposite must happen: "if the auth subsystem cannot
 * initialise, refuse connections rather than serving unauthenticated". So this pulls both loads
 * forward to boot, where a failure is attributable and loud.
 *
 * ── Both are fatal. The pepper used to be only a warning; here is why that changed ───────────
 *
 * A misconfigured KEYRING is unambiguously fatal: `loadKeyring` rejects an absent, short, or
 * published-example key, and every one of those means stored ciphertext is either unreadable or was
 * never protected. There is no degraded mode worth having.
 *
 * A missing PEPPER is equally fatal — no session can be issued, so nobody can sign in — but it used
 * to be logged and stepped over. The reasoning at the time was accurate: `initDatabase()` wrapped
 * this call in a `try/catch` that logged and CONTINUED, so throwing would have produced one error
 * line and an application that ran on regardless.
 *
 * That catch now rethrows, so the reason no longer holds and the behaviour is fixed to match. It
 * mattered: QA (INFRA-02) started an instance with no pepper and watched it log the error, print
 * "Flowise Server is listening at :3000", and stay up. With no HEALTHCHECK, an orchestrator would
 * report that container healthy while every single login failed — the worst kind of outage, because
 * nothing is obviously broken.
 *
 * Refusing to start is recoverable in seconds and impossible to misread. Serving a login page that
 * can never succeed is neither.
 *
 * The keyring failure is still thrown rather than logged, because `loadKeyring`'s own message names
 * the offending variable and the remedy, and it is worth having that appear as an error with a
 * stack rather than as one warning among many.
 *
 * ── Idempotence ──────────────────────────────────────────────────────────────────────────────
 *
 * `resetKeyring()` first, so calling this twice (the worker process boots the same path) re-reads
 * the environment rather than asserting against a cached keyring from a previous configuration.
 */
export const initAuthSecrets = async (): Promise<void> => {
    // Fail fast and loudly on key material: an unreadable keyring means every stored secret is
    // unreadable, which is not a state to discover mid-request.
    resetKeyring()
    let description
    try {
        description = loadKeyring().describe()
    } catch (error) {
        if (error instanceof KeyringError) {
            logger.error(`❌ [identity]: encryption keyring rejected — ${error.message}`)
        }
        throw error
    }

    // `describe()` is the safe-to-log view: versions, ids, sources and fingerprints, never material.
    logger.info(
        `🔑 [identity]: encryption keyring active=v${description.activeVersion} ` +
            `keys=[${description.keys.map((key) => `v${key.version}:${key.source}:${key.fingerprint}`).join(', ')}]`
    )

    // The pepper is checked, not consumed: `current()` throws when it is absent, and that throw is
    // the whole point of asking. Nothing is retained — the provider is re-read per session issue.
    try {
        const pepper = new EnvSessionPepperProvider().current()
        logger.info(`🔑 [identity]: session pepper active=v${pepper.version} keyId=${pepper.keyId}`)
    } catch (error) {
        logger.error(
            `❌ [identity]: session pepper unavailable — refusing to start. No session can be issued without it, ` +
                `so the server would accept connections and fail every sign-in. ` +
                `${error instanceof Error ? error.message : String(error)}`
        )
        throw error
    }
}

export default initAuthSecrets
