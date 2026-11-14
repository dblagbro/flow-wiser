# ADR-0006 — Fetching the master key and session pepper from the Coordinator Hub vault

**Status:** **Accepted for slice (a), Phase 1** — implemented behind `IDENTITY_KEY_SOURCE=vault`,
default off, enabled on no deployment. Sections 2 and 4 and the open questions were amended by the
Vault Architect's ruling C45 (2026-11-14); the amendments are marked where they apply.
**Date:** 2026-11-14
**Drafted for:** Operator; Vault Architect (ruling C42 admitted Flow-Wiser as a Phase 1 consumer,
slice (a))

## Context

Flow-Wiser holds two secrets that everything else depends on:

-   the **master key** (`IDENTITY_ENCRYPTION_KEY`, or a key file), from which every stored
    credential's encryption key is derived. Loaded in exactly one place, `identity/crypto/keyring.ts`;
-   the **session pepper** (`FLOWISE_SESSION_PEPPER`), which protects refresh-token digests.

Both are supplied through the environment or a file on the host. The operator's Coordinator Hub now
runs a credential vault, and Flow-Wiser was admitted as a consumer for **slice (a): fetch these two
at boot**, behind a flag, default off, with the existing sources kept as the fallback. Fetching the
stored third-party credentials themselves (slice (b)) is a later phase and is out of scope here.

Two existing rules pull against a naive implementation:

1. **Flow-Wiser fails closed.** No key, no start — and a key is never generated, because a silently
   invented key strands every stored credential (`keyring.ts`, requirements §1 and §9).
2. **The hub contract says the vault is the refresh path, never the read path.** A consumer keeps
   working from what it holds when the hub is slow, sealed or gone, and discards a secret only when
   the hub explicitly says `revoked` or `grant_denied`.

For most consumers rule 2 is satisfied by an encrypted local cache. For _this_ secret that is
circular: the cache would have to be encrypted under the very key being fetched.

## Decision (proposed)

### 1. A third key source, selected explicitly

`IDENTITY_KEY_SOURCE` = `env` (default — today's behaviour, unchanged) | `vault`.

With `env`, no vault code runs and no vault configuration is read. Turning the vault on is a
deliberate configuration change, never a side effect of a variable happening to be set.

### 2. Boot sequence with `IDENTITY_KEY_SOURCE=vault`

Before the keyring is first used, once:

1. Read the namespace bundle with a signed request (`identity/vault/requestSigner.ts`).
2. Classify the outcome with `identity/vault/wire.ts`. Then:

**Amended by ruling C45 — Phase 1 is no-lockout.** The first draft of this table refused to start
on a revoke and on a malformed bundle. The ruling reversed that for Phase 1: nothing the vault says
or fails to say may stop a deployment that still has its own key. The vault is used only when it
serves **both** secrets and they are the secrets this deployment already has; every other outcome is
"not this run", logged, and the environment/file source carries on.

| Outcome                                                                                    | Behaviour                                                                                     |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `OK`, both entries resolve, and they match the configured key and pepper where those exist | Keyring and pepper come from the vault. Start.                                                |
| `UNREACHABLE`, `REQUEST_REJECTED` (timeout, sealed, clock, signature, rate limit)          | Fall back, logged as a **warning**.                                                           |
| `REVOKED` or `DENIED` (the hub's explicit word), or an entry tombstoned as revoked         | Fall back, logged as an **alarm**. With `IDENTITY_VAULT_STRICT_REVOKE=true`: refuse to start. |
| Bundle untrusted, entry withheld, tombstoned or absent, unexpected status                  | Fall back, **alarm**. Never one secret from each source.                                      |
| The vault's key or pepper is not the configured one, or the keyring gate refuses it        | Fall back, **alarm** (`key_mismatch`, `pepper_mismatch`, `vault_key_rejected`).               |
| The flag is on but the vault settings or the identity key file are missing or unusable     | Fall back, **alarm** (`vault_misconfigured`, `identity_key_unusable`). No request is sent.    |

"Fall back" means the existing boot check runs unchanged on the environment/file source. If that
source is absent too, the server refuses to start exactly as it does today — no-lockout is not
no-key.

3. No key is ever generated, and none is written to disk by this path.

### 3. No on-disk cache of the master key in slice (a)

The environment/file source _is_ the fallback the ruling asked to keep, so an unreachable vault at
boot degrades to today's behaviour instead of to an outage. A cache of the master key would need a
second key to protect it, which only moves the problem. Revisit if and when the environment source
is retired.

### 4. No polling after boot in slice (a)

The keyring is loaded once per process today, and rotation is a restart plus a re-encryption pass.
Slice (a) keeps that: the vault is read at boot and not again. A revoke therefore takes effect at
the next start, not within a poll interval. This is a stated limit, not an oversight. (C45 accepted
it: for a boot-only consumer, "re-check on the next poll" means the next start.)

### 5. Values are never logged

Only the existing fingerprint (first 16 hex characters of SHA-256 over the material) and the vault
path and version appear in logs or in `describe()`.

## Consequences

-   Default behaviour is unchanged; the feature is inert until the flag is set.
-   An unreachable vault cannot take down a deployment that still has its environment key — and
    cannot be used to make one start on a key the operator revoked.
-   A deployment that has removed its environment key depends on the vault to boot. That is the
    intended end state, and it should not be reached before the vault is trusted.

## Rulings on the open questions (C45, 2026-11-14)

1. **Key identity and version — the vault mirrors.** The key id and version recorded on rows come
   from configuration (`IDENTITY_ENCRYPTION_KEY_ID`, `IDENTITY_ENCRYPTION_KEY_VERSION`), never from
   the vault's storage version counter. The first boot from the vault is not a rotation. The code
   enforces the mirror: where an environment key is still configured, a vault key with a different
   fingerprint is refused.
2. **Revoke versus fallback — no-lockout in Phase 1.** An explicit revoke at boot falls back with an
   alarm. Refusing to start is a separate, default-off flag (`IDENTITY_VAULT_STRICT_REVOKE`).
3. **Polling** — not in slice (a); see section 4.

Still open: the identity probe returned 404 on the hub's test listener, so wrong-service detection
is untested end to end; and what a deployment with no environment key holds the vault's value
against (I-39 in `docs/ISSUE-REGISTER.md`). The literal `revoked` response was exercised against the
live test listener on 2026-11-14 (`docs/vault-consumer.md`).

## The questions as first asked

1. **Key identity and version.** Every stored row records `keyId` and `keyVersion`, and the keyring
   refuses two different keys under one version. Existing rows are version 1 under the environment
   key. When the same material is later served by the vault, does it keep `keyVersion` 1 (the vault
   mirrors the existing key), or does the vault's own version number become the key version (which
   makes the first vault boot a rotation and needs the old key retained for reading)? The first is
   simpler and is what I recommend for slice (a): **the vault serves the existing key, and the key
   version is carried in the secret's metadata or fixed by configuration, not taken from the vault's
   version counter.**
2. **Revoke versus fallback.** Is "refuse to start on an explicit revoke even though an environment
   key is present" what the operator wants? It is the strict reading; the lenient one keeps the
   service up.
3. **`entry_revoked` on a 403.** Treated here as not cache-clearing; only the literal `revoked` and
   `grant_denied` are. Asked of the hub side.
4. **Scope of a denial.** A `grant_denied` for one namespace says nothing about another. The
   classifier reports the denial; what it clears must be scoped to the resource that was asked for.
5. **The identity probe** returned 404 on the hub's test listener on 2026-11-14, so wrong-service
   detection cannot yet be exercised end to end.
6. **Where the hub URL, namespace, entry names and identity key path are configured**, and that the
   identity's private key file gets the same enforced `0400`/`0600` treatment as a key file.
