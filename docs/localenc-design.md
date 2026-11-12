# LOCALENC — Flow-Wiser design memo (first deliverable)

**Status:** Design only. Feature **OFF by default / not live.** No production enablement without an
explicit operator line. Build phase is **copy-only against a duplicate store**; plaintext originals
stay in clear until the operator declares cut-over. Escrow precedes encryption (spec M8).

Flow-Wiser was not on the original LOCALENC roster; it joins per operator direction. This memo maps
Flow-Wiser's storage to the LE1 standard and the T1–T8 matrix. See "Operator questions" — the main
decision is whether Flow-Wiser's existing column-based AEAD envelope is accepted as an equivalent
control or must be re-serialised to the byte-exact LE1 codec.

## Pre-existing posture (what already exists)

`packages/server/src/identity/crypto/{aead,keyring}.ts` already provides authenticated encryption at
rest for the credential class, and it already satisfies the non-negotiable crypto mandates:

| Mandate | LE1 requirement                                                           | Flow-Wiser today                                                                                                                                                 |
| ------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1      | AES-256-GCM, no ECB/CBC-no-MAC, no home-rolled                            | AES-256-GCM via `node:crypto`; XChaCha20-Poly1305 reserved in the algorithm enum                                                                                 |
| M2      | envelope {version, key_id, algorithm, nonce}, header authenticated as AAD | `EncryptionMetadata` columns {keyId, keyVersion, algorithm, nonce, salt}; `keyId‖keyVersion‖algorithm` passed to GCM as AAD; 12-byte nonce; 16-byte tag appended |
| M3      | 256-bit keyed ring, id/created/state, retired=decrypt-only                | key-versioned via `EncryptionMetadata` + `keyring.ts`; rotation command exists                                                                                   |
| M5      | mainstream maintained lib                                                 | `node:crypto` stdlib only                                                                                                                                        |
| M6      | field/record-level, do not whole-file-encrypt SQLite                      | field-level on the `Credential.encryptedData` column; indexes/queries intact                                                                                     |

So Credential secrets are **already encrypted at rest, always-on** (stronger than a default-off
baseline for that class). LOCALENC's value for Flow-Wiser is (1) reconciling that envelope/key model
to the shared LE1 standard so a future `key_source: vault` can land, and (2) a **default-off**,
profile-gated path to extend encryption to further classes.

## (a) Inventory of sensitive fields by class, with current at-rest state

SQLite at `/root/.flowise/database.sqlite` (also Postgres/MySQL/MariaDB). Field-level, per spec M6.

-   **credential** — `Credential.encryptedData` (3rd-party API secrets) **[encrypted today]**;
    `ApiKey` (Flowise API keys) _clear_; identity `MfaFactor` (TOTP seed), `MfaRecoveryCode`, `Token`
    (session/reset), `LoginMethod` (SSO client secret) _clear_; `Variable` (secret-typed) _clear_;
    `CustomMcpServer` (command/env) _clear_. `User.credential` is an Argon2/bcrypt **hash**, not
    reversible — out of scope (hashing ≠ encryption).
-   **pii** — `Lead` (public-chatbot name/email/phone) _clear_; identity `User` (email, name),
    `Organization`/`Workspace` names _clear_.
-   **content** — `ChatMessage` (conversation text), `ChatFlow`/`Assistant`/`Tool`/`CustomTemplate`
    (flow definitions, may embed prompts/keys), `DocumentStore*` (uploaded docs), `Dataset*`,
    `Execution`, `UpsertHistory` _clear_.
-   **telemetry** — `AuditEvent`, `LoginActivity`, `ScheduleTriggerLog` _clear_.
-   **financial / health** — no platform-level tables; may appear inside `content` of user flows.
-   **public** — node catalog, versions, non-secret config — never encrypted.

## (b) First profile and why

**baseline** (credential class). Rationale: it is where real secrets live, most of it is already
encrypted, and the gap is small (bring `ApiKey`, `MfaFactor`, `MfaRecoveryCode`, `Token`,
`LoginMethod`, secret `Variable` under the same AEAD). `pii` (Lead, chat content) is the proposed
second profile; `health`/`financial` are not platform concerns and would be opt-in per deployment.
Classes are additive, never removed (spec §2).

## (c) Library and algorithm

`node:crypto`, **AES-256-GCM**, 12-byte random nonce, 16-byte tag, per-record HKDF-SHA-256 key from
the master. Matches M1/M5. **Gap vs LE1:** LE1 mandates a canonical-JSON header `{alg,kid,v}` as AAD
in a byte-exact wire envelope that passes the Hub's 5 KAT vectors; Flow-Wiser carries the same
authenticated fields in `EncryptionMetadata` columns rather than a JSON envelope blob. Options: (i)
add an LE1 serialiser/codec that round-trips to the column model and passes the KAT vectors, or (ii)
Architect accepts the column envelope as an equivalent compensating control. Also: LE1's key model is
master-wraps-DEK-ring (Argon2id for `strict`); Flow-Wiser derives per-record keys via HKDF from
`IDENTITY_ENCRYPTION_KEY`. Reconciling to a wrapped-DEK ring is the substantive build item.

## (d) Dual-store migration and T1–T8 mapping

Copy-only to a **duplicate** store (e.g. `database.localenc.sqlite`); originals untouched; single
default-off switch `LOCALENC_PROFILE` (off|baseline|pii|…) + per-class policy map + `key_source`
(local|vault). Escrow the master to the custodian **first** (L-2), then mint/activate.

-   **T1** encrypt: baseline fields ciphertext, clear fields readable, on/off behaviour identical.
-   **T2** round-trip clear↔enc↔clear, counts + checksums equal.
-   **T3** encrypted backup restores on a clean instance with the original key; unencrypted safety
    backup also restores.
-   **T4** rotation v1→v2 (keyring): v1 rows still decrypt, v1 backup reads under v2 ring, audited.
-   **T5** lost-key: refuses cleanly (existing `DecryptionError`, no null path), no corruption.
-   **T6** profile switch re-evaluates fields, no loss.
-   **T7** audit: every encrypt/decrypt/key-use/rotation/profile-change logged via `AuditEvent`, **no
    values**.
-   **T8** third-party plaintext rows (if any remain) listed with compensating control (0600 ring +
    container-scoped ownership) verified.

## (e) Performance

AES-GCM is negligible on Raspberry-Pi-class hardware (M7). Field-level keeps SQLite indexes (M6).
Only concern: per-record HKDF on bulk `ChatMessage`/`DocumentStore` content under a future `content`
profile — batch/stream and benchmark before enabling that class.

## (f) Operator questions (routed through Architect; work does not pause on them)

1. **Roster/scope:** confirm Flow-Wiser should join LOCALENC, and whether the first deliverable is
   "align existing credential encryption to LE1" (recommended) vs a broader build now.
2. **Envelope equivalence:** accept Flow-Wiser's column-based AEAD envelope as an equivalent control,
   or require a byte-exact LE1 codec passing the Hub KAT vectors? (Recommend: add an LE1 codec for
   interop, keep the column store as the physical format.)
3. **Key model:** keep HKDF-from-master, or migrate to the LE1 master-wraps-DEK-ring (Argon2id for
   `strict`)? (Recommend: wrapped-ring, since that is the single swap point for `key_source: vault`.)
4. **Escrow:** confirm the custodian path `…/localenc-escrow/flow-wiser/` and that an `ESCROWED
flow-wiser <key_id> <sha256>` line must appear before Flow-Wiser mints a LOCALENC master key.
