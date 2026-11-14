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

## Why it is a small change

`identity/crypto/keyring.ts` already separates where key material comes from from how records are
encrypted, and already holds several key versions with one active. A vault source is one more source
in that file. `aead.ts` and every stored row are untouched, because each row records only an opaque
`keyId` and `keyVersion`.

## What exists

| Piece                                                      | State                                                                               |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `identity/crypto/keyring.test.ts`                          | 69 tests pinning the keyring's behaviour before a source is added to it             |
| `identity/vault/requestSigner.ts`                          | RFC 9421 signer for the hub's pinned profile. Pure; reads no key, makes no request  |
| `identity/vault/requestSigner.test.ts`                     | 20 tests, including four known answers produced by the hub's own reference signer   |
| A client that fetches the bundle                           | **Not written**                                                                     |
| A `vault` key source in `keyring.ts`, and the flag         | **Not written**                                                                     |
| A fixture identity, its key pair, a test run against a hub | **Not done** — the hub side provisions the identity and asks for a public key first |

## The signing profile, as built to

The hub refuses anything else with a 401, so these are constraints, not preferences:

-   Ed25519 only.
-   Covered components, in order: `@method`, `@authority`, `@path`; then `@query` when the request
    has a query string; then `content-digest` when it has a body. Nothing else — not `@target-uri`.
-   Parameters, in order: `created`, `keyid`, `alg="ed25519"`, `nonce`; then `expires` when given.
-   `keyid` is the identity name the hub enrolled, not a key fingerprint.
-   `@authority` is the value the hub has configured as its canonical authority, lower-cased — not
    the `Host` header the client happens to send. `@path` is the full path as sent.

"Matches the hub" is tested rather than asserted: the known-answer vectors in
`requestSigner.test.ts` are headers produced by the hub's reference signer, and the TypeScript port
must reproduce them byte for byte.

## Rules for whoever continues this

-   No private key in the repository, in a fixture, or in a log — test vectors derive their keys at
    run time from a label. A real identity key lives outside the tree with owner-only permissions.
-   A missing or unreadable vault must fail closed exactly as a missing key does today: the server
    refuses to start. It must never fall through to generating a key.
-   Withheld, tombstoned or unreadable entries are refusals, not empty values.
-   Do not enable the flag on any deployment as a side effect of other work.
