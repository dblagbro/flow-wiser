# Issue and risk register

**Date:** 2026-08-08 · **Assessed at:** `apache2-only` · **Running:** `3.1.4-fw7`

Severity is assigned on **demonstrated** impact, not on how alarming the defect sounds. Where a
defect is latent rather than active, that is stated — overstating severity is as damaging to
prioritisation as understating it.

Legend — **S1** blocks release · **S2** must fix before wider use · **S3** should fix ·
**S4** track only.

---

## Security assessment 2026-08-07 — remediated in `3.1.4-fw5`

An independent, sanctioned assessment against a live instance. All three findings below are fixed
and each fix was verified by replaying the assessment's own conditions against the built image.

### SEC-01 · Code nodes could `require('fs')` — CONFIRMED HIGH → **FIXED**
`TOOL_FUNCTION_BUILTIN_DEP` was concatenated onto the sandbox require allowlist unfiltered; the
secure wrappers mock only HTTP libraries. Proven: `fs.readFileSync('/root/.flowise/database.sqlite')`
returned `SQLite format 3` — every stored credential — and `/mnt/s` (the NAS) was readable and
writable. **No vm2 escape required.**
**Fixed:** `filterDangerousBuiltIns` refuses 20 host-access builtins in code, plus `fs` removed from
the deployment config. **Verified:** fed the exact exploited value `crypto,fs,path`, the built image
allows `crypto,path` and logs a refusal.

### SEC-02 · Unauthenticated prediction of keyless flows — CONFIRMED MEDIUM → **FIXED**
`validateFlowAPIKey` returned `true` when a flow had no key. 22 of 25 flows were keyless.
**Fixed:** a prediction now needs a valid key, an explicit `isPublic`, or an authenticated caller.
**The first fix attempt was insufficient** and the retest caught it: the check also lives inside
`utilBuildChatflow`, but the controller resolves the flow, evaluates origin rules and runs the
streaming validator *before* reaching it — so an unauthenticated request still hit real work and
still returned the same 500 the assessment had observed. The gate now sits at the top of
`createPrediction`. Audited the other whitelisted routes: `/api/v1/prediction/` was the only
whitelisted route that executes a flow.

### SEC-03 · Public flow + code node = unauthenticated code execution → **FIXED**
Publishing a flow containing a code-execution node is refused with a message naming the nodes.
Private flows with code nodes are untouched — the risk is the combination. Detection matches node
names *and* non-empty code-bearing input fields, so a node type added later is still caught.

### Verified already hardened — do not re-fix
SSRF from code nodes (deny list covers `169.254.169.254`, RFC1918, localhost, `::1`, on by default);
vm2 command-exec escapes (blocked by `Proxy` removal + `eval:false`); path traversal in
`get-upload-file`; unauthenticated MCP execution.

### SEC-04 · `vm2` remains deprecated and unpatchable — **OPEN, tracked**
Escapes are blocked by configuration, not by the library. Durable fix is `isolated-vm` or the
already-present `@e2b/code-interpreter`; it touches every code-node type and is scheduled separately
rather than rushed into a security release. Until then, *who can author a code node* and *which
flows are public* are host-RCE-equivalent trust boundaries.

**Correction to a prior claim:** `3.1.4-fw4` described the `vm2` 3.11.5 pin as closing six critical
sandbox escapes. 3.11.5 is the final release of a deprecated package; the pin moved off a worse
version but did not make the sandbox safe.

---

## Security retest 2026-08-07 → remediated in `3.1.4-fw6` / `fw7`

| id | Finding | Status |
|---|---|---|
| N6 | Runtime variables read arbitrary `process.env` — any `variables:create` holder could read the token-signing secret and forge tokens for any tenant | **FIXED** — `FLOWISE_VAR_` prefix required |
| N7 | `GET /credentials/:id` returned plaintext to 4 of 6 roles; `credentials:reveal` enforced on no route; the two endpoints were inverted | **FIXED** — GET redacts, `/reveal` requires the permission |
| N3 | `node:`-prefixed builtins bypassed the sandbox denylist | **FIXED** — canonicalised before matching |
| N1 | Weak credential-encryption key | **DROPPED** at operator direction — deployment concern on a dev/test box, not a product defect |
| N2 | `0.0.0.0:3000` LAN binding | **DROPPED** by the assessors — app auth holds regardless |
| N4/N5 | Override switches and the Origin gate | Informational; documented in `COMPLIANCE-POSTURE.md` |

### Two claims in the retest report that were WRONG
The report stated `vm2` had been removed from the image and that the E2B remote sandbox was active.
Verified false on 2026-08-07: `vm2@3.11.5` is present and referenced in the built `utils.js`, and
`E2B_APIKEY` was unset, so execution was local. Their conclusion on unauthenticated RCE still holds,
but the "vm2 → MOOT" verdict rests on a false premise. `3.1.4-fw7` now states the sandbox posture in
the boot log so this is not re-derivable incorrectly.

### I-20 · `audit:export --from` / `--to` failed at runtime — **FIXED in fw7**
Both filters referenced `e.createdDate`; the column is `occurredAt`. Inside a query-builder string,
so TypeScript could not catch it and it shipped in fw6. Found only when `audit:prune` made the same
mistake in a typed context. **Lesson:** a green compile does not cover anything expressed as a string.

### I-21 · 12 deleted credentials still referenced by 9 flows — **OPEN, operator data**
`doctor` reports 21 references across 9 flows, including `devin-resume-chatGPT-current` and
`therabot-staging-ES-vector`. Those flows will fail at runtime on a missing credential. Not a code
defect; left reported rather than suppressed. **This is why `doctor` still exits 1.**

---

## S1 — Blocks release

### I-01 · Published images `fw1`–`fw3` contain commercially licensed code
**Status:** open, **legal not technical** · **Evidence:** `COPY . .` with no `.dockerignore` shipped
71 MB of `upstream-archive/`, including 11,357 lines of licensed source, into every image built
before 2026-08-07. `dblagbro/flow-wiser:latest` still points at `fw3`.
**Impact:** the FlowiseAI Commercial License forbids distribution. These are public on Docker Hub now.
**Action:** delete or deprecate the tags. **Requires operator decision — irreversible and outward-facing.**
**Verification:** `docker manifest inspect` returns not-found for the removed tags.

### I-02 · `doctor` exits 1 on any instance where content exists — **FIXED in 3.1.4-fw6**
**Status:** CLOSED 2026-08-08. `resolveOrganizationIdForWorkspace` writes the key on create; 25/25 production rows backfilled; `doctor`'s tenancy check now passes. **Original report follows.** · reproduced 2026-08-07 · **Evidence:** fresh instance, one chatflow created via
the API → `chat_flow.organizationId` NULL while its workspace carries
`6e9ea080-…`; `doctor` reports `[FAIL] Tenancy — denormalised tenant keys`, exit 1. Empty instance
exits 0.
**Root cause:** `controllers/chatflows/index.ts:175` sets `newChatFlow.workspaceId`; nothing anywhere
sets `organizationId`. Migration `1780000000012` added the column to ten tables; no write path
populates it.
**Severity note — NOT a live tenant breach.** No production query reads `organizationId` on a content
table. Verified: every content query scopes by `workspaceId` via `getWorkspaceSearchOptions`, and the
three organisation-scoped paths resolve organisation → workspaces first
(`services/chatflows/index.ts:224`, `assistants:219`, `apikey:100` joins `workspace.organizationId`).
`workspaceId` **is** correctly written. So the column is currently dead weight and §3a's intended
safety net does not exist — but nothing is being served to the wrong tenant today.
`doctor`'s own message ("served to the wrong tenant by any query that filters on organization alone")
describes a hypothetical query that does not exist; it should be reworded.
**Impact:** `doctor` is unusable as a health gate, which is its entire purpose.
**Action:** write `organizationId` on create/update across the ten §3a tables; backfill existing rows;
reword the doctor finding.
**Acceptance:** create content on a fresh instance → `doctor` exits 0; a row with a mismatched key is
still detected (negative control).

### I-03 · Versioning has zero automated tests
**Evidence:** `find` over `packages/server/**/*.test.ts` matching `versioning` → 0.
**Impact:** the feature contained a path-traversal arbitrary-file-write (fixed 2026-08-06) that no
test would catch if reintroduced. Capture, diff, restore and tag are all unprotected.
**Acceptance:** tests for slug sanitisation (including traversal payloads), the no-op-change check,
word-segment diffs, and a restore round-trip asserting byte identity.

---

## S2 — Must fix before wider use

### I-04 · `recovery-cli.test.ts` (30 tests) has never executed
**Evidence:** 32 suites collected, 4 fail to **load**; summary still reports `844 passed`.
**Root cause:** two independent blockers — `typeorm` mock lacked `ViewColumn` (**fixed 2026-08-07**),
and the suite needs **real** TypeORM against a real SQLite file while `jest.config.js` globally mocks
TypeORM for the 29 unit suites.
**Action:** jest `projects` split — unit (mocked) vs integration (real). A `flowise-components`
mapping alone was tried and **reverted**: it makes the suite load and then all 30 fail.
**Acceptance:** `pnpm test` runs 32/32 suites; CI fails on a suite-load failure, not only on assertions.

### I-05 · Node CI cannot validate the shipping artifact
**Evidence:** `main.yml` pins Node `24.15.0`; the image must be Node 20 because Node 24 cannot compile
`better-sqlite3`. Node CI has produced **one** result in project history: failure, on `main` at
`a582a7d3` — an ancestor of current HEAD. It does not trigger on `apache2-only` at all.
**Action:** trigger on `branches: ['**']`; matrix Node 20 (ships) and 24 (upstream parity), allowing
24 to fail; fix or characterise the existing failure.
**Acceptance:** green run on `apache2-only` at Node 20.

### I-06 · The favicon fix lives only in the bind-mounted build
**Evidence:** `ui-build/index.html` + `manifest.json` edited on the host; `packages/ui` source still
emits the relative `href="favicon.ico"` that caused the site-wide leak.
**Impact:** the next UI rebuild silently reintroduces it on voipguru.org.
**Acceptance:** built-from-source `index.html` contains `/assets/favicon.ico`.

---

## S3 — Should fix

| id | Issue | Evidence / note |
|---|---|---|
| I-07 | `POST /account/reset-password` has no rate limit | `/auth/login` has per-IP and per-account limiters. Narrower surface (needs a valid session *and* the current password) but still a guessing oracle. |
| I-08 | `VersionStore.history()` is O(all commits) per request | One shared repo for every flow; an old flow's history slows as unrelated flows commit. |
| I-09 | `expect` absent from the image | `admin:create` requires a TTY; the recovery path the boot log prints cannot run unattended. |
| I-10 | `resetPassword.jsx` reads `error.response.data` unguarded | A network failure throws a TypeError over the real error. |
| I-11 | `Docker Image CI - Docker Hub` would publish the wrong artifact | Builds `docker/Dockerfile` (npm path → commercial output), pushes to `flowiseai/flowise`, defaults to Node 24. Warning comment added; workflow not rewritten. |
| I-12 | Checkpoint labels are slugified, not rejected | `../../../PWNED` → 200 as `usr-src-flowise-pwned-by-tag`. Safe, but silently renames. **Open decision.** |
| I-13 | `doctor` tenancy message describes a query that does not exist | See I-02 severity note. Misleads an operator into believing data is being cross-served. |

## S4 — Track only

| id | Issue |
|---|---|
| I-14 | MySQL untestable on this host (`dev/ptmx` unpack error); MariaDB is the executed proxy |
| I-15 | Mixed `workspaceId` types on Postgres — `custom_mcp_server` is `text`, `schedule_*` `varchar`, new columns `uuid`; a join to `identity_workspace.id` is a hard error |
| I-16 | `migrate.ts` stamps `organizationId` on more tables than §3a lists — the two disagree |
| I-17 | `1755066758601` relies on SQLite's double-quoted-identifier misfeature; would stamp the literal string `workspaceId` on a non-empty table |
| I-18 | 5 identity-administration endpoints return 501 by design (no Apache-2.0 call site) |
| I-19 | `MEMORY.md` carried a "≤140 lines / ≤17KB" rule linking to a nonexistent file; no evidence the operator set it. Remove. |

---

## Risks not yet defects

- **Single-operator bus factor.** Every verification to date is manual and undocumented as a
  runbook. `docs/PUBLISH-3.1.4-fw4.md` is the only exception.
- **No evaluation harness.** Nothing detects a regression in prompt-diff quality, migration
  fidelity, or boot health except a human running commands.
- **Git history necessarily contains the licensed files.** All 307 upstream tags are preserved, so
  the 127 files exist at historical commits. Stated in `LICENSE.md`/`FORK.md`; cannot be changed
  without destroying the fork's provenance.
