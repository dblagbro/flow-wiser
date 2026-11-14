# ADR-0006 — Fetching the master key and session pepper from the Coordinator Hub vault

**Status:** **Proposed** — nothing here is implemented or enabled. Open questions at the end need an
answer from the operator or the Vault Architect before the boot path is written.
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

| Outcome                                                                 | Behaviour                                                                                                                                    |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `OK`, bundle parses, both entries resolve to non-empty strings          | Build the keyring from the vault's values. Start.                                                                                            |
| `UNREACHABLE` (timeout, 502/503/504, sealed, degraded)                  | Use the environment/file source **if one is configured**; log loudly that the vault was unreachable. If none is configured, refuse to start. |
| `REVOKED` or `DENIED` (the hub's explicit word)                         | **Refuse to start, even if an environment/file source is configured.** A fallback that survives a revoke is not a revoke.                    |
| Bundle malformed, wrong namespace, entry withheld, tombstoned or absent | Refuse to start. Never a partial keyring.                                                                                                    |
| `REQUEST_REJECTED` (signature, clock, nonce, rate limit), `UNEXPECTED`  | Treated as `UNREACHABLE`: a misconfigured client is not a withdrawn credential.                                                              |

3. No key is ever generated, and none is written to disk by this path.

### 3. No on-disk cache of the master key in slice (a)

The environment/file source _is_ the fallback the ruling asked to keep, so an unreachable vault at
boot degrades to today's behaviour instead of to an outage. A cache of the master key would need a
second key to protect it, which only moves the problem. Revisit if and when the environment source
is retired.

### 4. No polling after boot in slice (a)

The keyring is loaded once per process today, and rotation is a restart plus a re-encryption pass.
Slice (a) keeps that: the vault is read at boot and not again. A revoke therefore takes effect at
the next start, not within a poll interval. This is a stated limit, not an oversight.

### 5. Values are never logged

Only the existing fingerprint (first 16 hex characters of SHA-256 over the material) and the vault
path and version appear in logs or in `describe()`.

## Consequences

-   Default behaviour is unchanged; the feature is inert until the flag is set.
-   An unreachable vault cannot take down a deployment that still has its environment key — and
    cannot be used to make one start on a key the operator revoked.
-   A deployment that has removed its environment key depends on the vault to boot. That is the
    intended end state, and it should not be reached before the vault is trusted.

## Open questions — answers needed before the boot path is written

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
