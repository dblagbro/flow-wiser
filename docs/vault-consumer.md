# Vault consumer — Flow-Wiser and the Coordinator Hub vault

**Status, 2026-11-14:** preparation only. Nothing here is enabled, and no code path reads a key from
the vault. This document records what was decided, what exists, and what must not be assumed.

## What was decided

Flow-Wiser was admitted as a **Phase 1 consumer** of the Coordinator Hub credential vault on
2026-11-14 (ruling C42 in the operator's `[VAULT-IMPL-2]` coordination thread), for **slice (a)**
only:

-   the credential-encryption master key and the session pepper are fetched from the vault **at
    boot**, over the hub's convenience bundle surface, with RFC 9421 signed requests;
-   behind a flag (`key_source=vault`), **default off**, with the existing environment and key-file
    sources kept as the fallback;
-   built test-first against a fixture identity on a test hub, in a throwaway container.

The per-credential store (slice (b)) is Phase 2 and is not started. Production, real keys and host
changes each need the operator's explicit instruction; none is implied by this work.

The proposed boot behaviour, and the questions that must be answered before it is written, are in
[ADR-0006](decisions/ADR-0006-vault-key-source.md).

## Why it is a small change

`identity/crypto/keyring.ts` already separates where key material comes from from how records are
encrypted, and already holds several key versions with one active. A vault source is one more source
in that file. `aead.ts` and every stored row are untouched, because each row records only an opaque
`keyId` and `keyVersion`.

## What exists

| Piece                                                                | State                                                                                    |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `identity/crypto/keyring.test.ts`                                    | 69 tests pinning the keyring's behaviour before a source is added to it                  |
| `identity/vault/requestSigner.ts`                                    | RFC 9421 signer for the hub's pinned profile. Pure; reads no key, makes no request       |
| `identity/vault/requestSigner.test.ts`                               | 20 tests, including four known answers produced by the hub's own reference signer        |
| `identity/vault/wire.ts`                                             | Wire-state classifier, identity check, strict bundle parser. Pure; makes no request      |
| `identity/vault/wire.test.ts`                                        | 90 tests; the cache-clearing rule is tested from both sides                              |
| `identity/vault/bundleClient.ts`                                     | One signed read of a namespace bundle. No cache, no retry, no redirect, bounded body     |
| `identity/vault/bundleClient.test.ts`                                | 44 tests against a real loopback HTTP server that verifies the signature as the hub does |
| `identity/vault/bootSecrets.ts` and a `vault` source in `keyring.ts` | The boot path, behind `IDENTITY_KEY_SOURCE=vault`. **Default off; enabled nowhere**      |
| `identity/vault/bootSecrets.test.ts`                                 | 59 tests: every outcome, strict mode, the mirror check, no partial result                |
| A fixture identity and a first run against the hub's test listener   | **Done 2026-11-14** — see below                                                          |

## First run against the hub's test listener — 2026-11-14

Identity `fixture-flowwiser-reader`, on the hub's loopback-only test listener, reached through an
SSH local forward. Synthetic values only; none was printed, stored or fed to any key derivation. The
identity's private key was generated on the development host, outside the repository, mode `0600`.

| Check                                                                                        | Result         |
| -------------------------------------------------------------------------------------------- | -------------- |
| Signed bundle read; strict parse; two entries map to the master-key and session-pepper slots | PASS           |
| ETag header equals bundle `etag`; `If-None-Match` gives 304; response is `no-store`          | PASS           |
| Signed audit read with a query string                                                        | PASS           |
| Namespace outside the grant: 403 `grant_denied`                                              | PASS           |
| Unsigned, tampered signature, unknown identity, replayed nonce: 401, nothing cleared         | PASS           |
| The real `fetchBundle`: bundle, 304, out-of-grant denial, unknown identity, unreachable hub  | PASS (6 of 6)  |
| Identity probe (`GET …/identity`)                                                            | **FAIL — 404** |

The identity probe is not served by that listener, so wrong-service detection is untested end to
end. That is recorded as open, not waved through.

The run found one defect on this side: the first attempt signed `http://127.0.0.1:8232` and was
refused on every request. **The hub verifies a bare `host[:port]`.** `bundleClient` now refuses any
other shape before sending anything.

## Second run, the boot path with the flag on — 2026-11-14

`resolveVaultBootSecrets` itself, against the same test listener and fixture identity, pointed at the
two synthetic entries as if they were the master key and pepper. Throwaway environment secrets
generated per run; every result was discarded, nothing was installed and nothing was derived.

| Case                                                            | Result                                     |
| --------------------------------------------------------------- | ------------------------------------------ |
| Synthetic values with an environment key configured             | PASS — fallback, alarm, `key_mismatch`     |
| Default entry names, which this namespace does not hold         | PASS — fallback, alarm, `absent`           |
| A namespace outside the grant                                   | PASS — fallback, alarm, `grant_denied`     |
| The same in strict mode                                         | PASS — refuses to start                    |
| An unknown identity, strict mode on                             | PASS — fallback, warning; not a revoke     |
| An unreachable hub                                              | PASS — fallback, warning, `no_response`    |
| A URL-shaped authority                                          | PASS — `vault_misconfigured`, nothing sent |
| Flag off                                                        | PASS — disabled                            |
| Synthetic values with **no** environment key to compare against | **Accepted** — see below                   |

**Finding (I-39), since fixed.** With no environment key configured there was nothing to hold the
vault's value against, and any value of 32 bytes or more that was not a published example was
accepted as the master key. Ruled the same day (C50 §3) and closed by the expected-key fingerprint
described under "Turning it on". Re-run after the fix: the same case is refused with
`fingerprint_required`, and a fingerprint that is not the served value's is refused with
`key_mismatch` (10 of 10).

## Third run, the literal revoke — 2026-11-14

The hub side placed one entry in state `revoked` in the fixture namespace. 8 of 8:

-   a direct read of the revoked entry answers 403 with the hub's own `revoked`, classified
    `REVOKED`, cache-clearing;
-   the namespace bundle is still served, with the two live entries and one tombstone whose reason
    is `revoked`; the parser refuses to resolve the revoked entry and still resolves the others;
-   the boot path with its master-key slot pointed at the revoked entry falls back with an alarm
    naming the entry, and refuses to start in strict mode;
-   in strict mode with the slots on the two live entries, the sibling's tombstone does **not**
    refuse the start. A revoke counts only for an entry this consumer asked for.

## Turning it on

Off unless `IDENTITY_KEY_SOURCE=vault`. With the flag off no vault setting is read and no request is
made.

| Variable                                | Meaning                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `IDENTITY_KEY_SOURCE`                   | `vault` turns the path on. Anything else, or unset, is today's behaviour                   |
| `IDENTITY_VAULT_URL`                    | Where to send the request, for example an SSH-forwarded loopback port                      |
| `IDENTITY_VAULT_AUTHORITY`              | The hub's canonical authority, a bare `host[:port]` — what gets signed                     |
| `IDENTITY_VAULT_NAMESPACE`              | The namespace holding the two entries                                                      |
| `IDENTITY_VAULT_IDENTITY`               | The enrolled identity name (the signature `keyid`)                                         |
| `IDENTITY_VAULT_IDENTITY_KEY_FILE`      | Ed25519 private key, PEM, mode `0400` or `0600` — refused otherwise                        |
| `IDENTITY_VAULT_MASTER_KEY_ENTRY`       | Entry name, default `master-key`                                                           |
| `IDENTITY_VAULT_SESSION_PEPPER_ENTRY`   | Entry name, default `session-pepper`                                                       |
| `IDENTITY_VAULT_PREFIX`                 | API prefix, default `/claudeCoordinator/api/v1/vault`                                      |
| `IDENTITY_VAULT_TIMEOUT_MS`             | Request timeout                                                                            |
| `IDENTITY_VAULT_MASTER_KEY_FINGERPRINT` | The expected key's fingerprint, 16 hex characters. Required when no environment key is set |
| `IDENTITY_VAULT_STRICT_REVOKE`          | `true`: an explicit revoke refuses to start. Default off                                   |

Keep `IDENTITY_ENCRYPTION_KEY` and `FLOWISE_SESSION_PEPPER` set while the vault is on trial. They
are the fallback, and they are also what the vault's values are checked against: the vault is used
only when it serves the same key and the same pepper. A boot that did not use the vault says so in
one line beginning `VAULT NOT USED THIS RUN`, with a code and no secret value.

### The expected-key fingerprint, and removing the environment key

The vault's key is only ever accepted when it can be shown to be the key this deployment expects.
While `IDENTITY_ENCRYPTION_KEY` is set, that is a direct comparison. Once it is not, the only thing
left to compare with is `IDENTITY_VAULT_MASTER_KEY_FINGERPRINT`: the first 16 hex characters of
SHA-256 over the key, which is not secret and is printed in the boot log on the `encryption keyring`
line. Without it, the vault's value is refused (`fingerprint_required`); with it, a value that does
not match is refused (`key_mismatch`). Either way there is then no key to start on, and the server
refuses to start with both reasons in the log. A fingerprint that is set is checked even while the
environment key is still there.

**Removing the environment key is a cut-over step and needs the operator's explicit line for that
deployment** (ruling C50 §3). Set the fingerprint first, see a boot that used the vault, and only
then remove the key.

The session pepper has no equivalent pin: with no `FLOWISE_SESSION_PEPPER` set, any non-empty vault
value is accepted. A wrong pepper signs every user out and loses nothing. Whether it should be
pinned too has been asked and is not decided.

## The signing profile, as built to

The hub refuses anything else with a 401, so these are constraints, not preferences:

-   Ed25519 only.
-   Covered components, in order: `@method`, `@authority`, `@path`; then `@query` when the request
    has a query string; then `content-digest` when it has a body. Nothing else — not `@target-uri`.
-   Parameters, in order: `created`, `keyid`, `alg="ed25519"`, `nonce`; then `expires` when given.
-   `keyid` is the identity name the hub enrolled, not a key fingerprint.
-   `@authority` is the value the hub has configured as its canonical authority: a **bare
    `host[:port]`, no scheme**, lower-cased — not the `Host` header the client happens to send.
    `@path` is the full path as sent.

"Matches the hub" is tested rather than asserted: the known-answer vectors in
`requestSigner.test.ts` are headers produced by the hub's reference signer, and the TypeScript port
must reproduce them byte for byte.

## The one rule about revocation

`wire.ts` decides, in one place, what an HTTP outcome means. **Only an explicit `revoked` or
`grant_denied` in the hub's own JSON error body, on a 401 or 403, clears anything held locally.** A
sealed vault, a timeout, a proxy's error page, a bare 401 or 403, a clock or nonce rejection, a rate
limit and a 501 all leave it alone. Wrong in one direction, a withdrawn credential keeps being used;
wrong in the other, a hub restart makes every consumer discard keys it still needs.

## Rules for whoever continues this

-   No private key in the repository, in a fixture, or in a log — test vectors derive their keys at
    run time from a label. A real identity key lives outside the tree with owner-only permissions.
-   Phase 1 is no-lockout (ruling C45): a missing, unreadable or revoking vault means "not this
    run" and the environment/file source carries on. If that source is absent too, the server
    refuses to start as it always has. Nothing on this path ever generates a key.
-   Withheld, tombstoned or unreadable entries are refusals, not empty values.
-   Do not enable the flag on any deployment as a side effect of other work.
