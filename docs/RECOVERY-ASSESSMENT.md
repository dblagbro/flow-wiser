# Recovery assessment — Flow-Wiser

**Date:** 2026-08-07 · **Commit assessed:** `7e7c5a9e` (`apache2-only`)

This is an evidence-based reconstruction of project state. It deliberately does **not** trust prior
status reports, including my own — the immediate trigger for it was that "100% Apache 2.0" was
asserted three times while 11,357 lines of commercially licensed source sat in `upstream-archive/`
and in every published container image.

Read with `ISSUE-REGISTER.md` (what is broken) and `PROCESS-GAPS.md` (why it was not caught).

---

## 1. Intended end state

A **freely redistributable, wholly Apache-2.0** flow-builder that a Flowise operator can migrate
onto without losing data or access — with the authentication, RBAC and multi-tenancy upstream
licensed commercially, plus flow/prompt versioning upstream never had.

Primary users: the operator (voipguru.org, ~25 chatflows in production) and Flowise operators
stranded by the 2026-08-03 EOL.

**Open decision (blocks prioritisation):** is the target a *public release others adopt*, or a
*working private instance*? Public makes the licensing exposure and test infrastructure urgent;
private makes the tenant-key defect urgent and defers the rest.

## 2. What is verified to work

Each row names the evidence, not the existence of code.

| Capability | Evidence |
|---|---|
| Boots on SQLite | container start, 0 ERROR lines, all init steps logged |
| Boots on Postgres 16 | same, plus `uuid-ossp` 0→1 and 54 migrations applied |
| Login / session / logout | HTTP 200 with full role+org+workspace payload; wrong password 401 |
| Forced password change | 403 `must_change_password` → change → 200; old password 401, new 200 |
| Password-change refusals | five paths provoked, each correct status, flag still set after every one |
| Six-role hierarchy seeds | `identity_role` = 6 on a virgin instance |
| Env-driven bootstrap | `FLOWISE_BOOTSTRAP_EMAIL/_PASSWORD` creates an account that logs in |
| Bootstrap idempotence | restart → counts unchanged (6 roles / 1 account / 1 org) |
| Migration from Flowise 3.x | run against a copy of the production DB; content hashes identical |
| Versioning capture/diff/restore | history, word-level prompt diff, restore round-trips identical |
| Repository is Apache-2.0 only | 0 files under `src/enterprise/`, 0 licensed lines in patches |
| Server test suite | **844 tests pass** in 28 of 32 suites (see §3) |

## 3. What is NOT verified, or verified-and-broken

| Item | Status |
|---|---|
| `doctor` on a populated instance | **Reported FAILING** — tenant key never written. Not independently reproduced yet. |
| 4 of 32 test suites | **Cannot load.** `recovery-cli.test.ts` (30 tests) among them — never executed. |
| Anything built on 2026-08-06 | Verified **manually and unrepeatably** (curl, `docker run`, ad-hoc scripts). |
| Versioning | **Zero automated tests** for the whole feature, including the module that carried a path-traversal write. |
| CI | Has produced **one** Node CI result in project history: **failure**, on `main` at `a582a7d3`. |
| Published images `fw1`–`fw3` | Contain commercially licensed compiled output. `:latest` points at `fw3`. |

**The load-failure pattern deserves emphasis.** A suite that fails to *load* contributes zero tests
to the total, so the summary line reads `844 passed` whether those 30 tests pass, fail, or do not
exist. Suite count is the signal; test count hides it.

## 4. Architecture and execution paths

- **Boot** — `initDatabase()`: DataSource init → `ensurePostgresUuidExtension` → migrations →
  `runIdentityBootstrap` (seeds six roles + tenancy + env admin) → identity manager → nodes pool.
  Failures are **fatal by design** (a swallowed error previously produced a half-started server).
- **Request auth** — cookie session resolved by `initializeJwtCookieMiddleware`/`verifyToken`, then
  `enforcePasswordChange`. Separately, a bootstrap gate treats any non-whitelisted `/api/v1` path
  **without** the header `x-request-from: internal` as an external API-key call. The shipped UI sets
  that header (`packages/ui/src/api/client.js`); anything else gets 401. **This is a persistent
  testing trap** — it produced a false "regression" during verification.
- **Identity** — `packages/server/src/identity/` (crypto, rbac, services, routes, tenancy).
- **Versioning** — `packages/server/src/versioning/` + `routes/flow-versions/`, git-backed via
  `isomorphic-git`, store at `<data-dir>/versions`.
- **Recovery CLI** — `packages/server/src/commands/`, passwords read from `/dev/tty` only.

## 5. Dependency and platform constraints

- **Node 20 is mandatory for the image**: Node 24 cannot compile `better-sqlite3` under node-gyp.
  **CI pins Node 24.** The suite therefore never runs on the Node that ships — a structural gap,
  not a configuration slip.
- `isomorphic-git` chosen because the Alpine image has no git binary and native builds are a live
  failure mode here.
- `vm2` pinned 3.11.5 as a direct dependency + `pnpm.overrides`. It was **3.11.2 in the source
  tree** until 2026-08-07; the 3.11.5 pin existed only in `docker/Dockerfile`, so a source build —
  which is what the release is — would have shipped the vulnerable sandbox.
- MySQL cannot be tested on this host: every mysql image fails to unpack (`dev/ptmx` layer error).
  MariaDB is the executed proxy; MySQL rests on textual parity.

## 6. Documentation that conflicted with implementation

- `CLEANROOM-ATTESTATION.md` / `HOW-WE-DID-THIS.md` describe a pre-commit hook and CI job that
  "reject any commit that modifies a protected path". Neither was in force for any commit made on
  2026-08-06 (§ `PROCESS-GAPS.md` G1).
- `account.ts` asserted the recovery CLI could clear `mustChangePassword`. Nothing could — the
  instance was unrecoverable. Corrected.
- `LICENSE.md` / `NOTICE` / `README.md` / `FORK.md` claimed 100% Apache 2.0 while the archive
  carried licensed source. Now true; **the claim preceded the fact by roughly nine hours.**
- `MEMORY.md` carried a "≤140 lines / ≤17KB" rule linking to a **file that does not exist**. No
  evidence the operator ever set it. Treated as fabricated and to be removed.

## 7. Unresolved decisions

1. Public release vs private instance (see §1).
2. Whether `fw1`–`fw3` should be deleted/deprecated on Docker Hub — the only item whose delay
   carries legal rather than technical risk.
3. Checkpoint labels are **slugified, not rejected**: `../../../PWNED` returns 200 as
   `usr-src-flowise-pwned-by-tag`. Safe, but silently renames. Reject instead?
4. Whether `packages/ui` should carry the favicon fix now applied only to the bind-mounted build.
