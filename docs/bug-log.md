# Bug log — QA of 3.1.4-fw8-rc2

**Run:** 2026-08-09/10 · **Candidate:** `3.1.4-fw8-rc2` · **Fixes on:** `fix/open-core-route-gating` (PR #8)

Full detail per finding lives in the domain reports; this is the register.

| ID        | Finding                                                                                                                     | Severity     | Status                                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------- |
| SEC-01    | /api/v1/public-chatbotConfig returns full flowData of a NON-public flow, unauthenticated                                    | **CRITICAL** | FIXED — shared auth ladder; NOT YET DEPLOYED                                                                         |
| UI-01     | First login is impossible: password-change gate blocks the SPA document; every 403 maps to /unauthorized                    | **BLOCKER**  | FIXED                                                                                                                |
| OPS-01    | credential:rotate-encryption reports 'nothing to do' when the key is WRONG                                                  | **HIGH**     | FIXED — trial decrypt per key version                                                                                |
| OPS-03    | doctor has no encryption-key check; a wrong-key restore passes 9/9                                                          | **HIGH**     | FIXED — new Crypto check                                                                                             |
| API-03    | `read-only` can execute flows, upsert vectors, delete chat history                                                          | **HIGH**     | FIXED — guards on 4 routers                                                                                          |
| UI-02     | /sso-config white-screens the entire app on an empty loginmethod response                                                   | **HIGH**     | FIXED — normalised + real error boundary                                                                             |
| STATIC-03 | Mandatory secrets absent from every .env.example; fresh install cannot issue sessions                                       | **HIGH**     | FIXED                                                                                                                |
| INFRA-06  | README compose quickstart pulls upstream's non-redistributable image                                                        | **HIGH**     | FIXED                                                                                                                |
| STATIC-01 | path-to-regexp pinned 8 majors below what express-5 consumers declare                                                       | **HIGH**     | FIXED — scoped to express@4                                                                                          |
| OPS-02    | Undocumented `flowise user <email> <password>`: argv password, no audit row                                                 | **HIGH**     | FIXED — command removed                                                                                              |
| SEC-B-02  | `::` absent from the SSRF deny list; routes to loopback                                                                     | **HIGH**     | FIXED + negative test                                                                                                |
| CI-01     | release-gate: tag name interpolated into shell; `skipped` counted as success                                                | **HIGH**     | FIXED                                                                                                                |
| CI-02     | Clean-room guard's protected paths did not cover `.github/workflows/**`, so a PR could disable the guard policing it        | **HIGH**     | PARTIAL — CODEOWNERS added; needs "Require review from Code Owners" enabled on main                                  |
| SEC-A-01  | argon2 redaction stops at the first comma; salt and digest survive                                                          | **MEDIUM**   | FIXED + negative test                                                                                                |
| API-01    | chatflows-streaming has no auth or ownership check                                                                          | **MEDIUM**   | FIXED — shared auth ladder                                                                                           |
| API-09    | Unauthenticated POST /leads persists into a private flow                                                                    | **MEDIUM**   | FIXED — anon writes only on public flows                                                                             |
| OPS-04    | Credentials written with organizationId NULL; doctor goes red after normal use                                              | **HIGH**     | FIXED — tenant key set on all four create paths                                                                      |
| OPS-09    | audit:export --verify prints a digest and exits 0 either way                                                                | **MEDIUM**   | FIXED — --expect, exits 3 on mismatch                                                                                |
| INFRA-02  | Missing FLOWISE_SESSION_PEPPER starts a live-but-unusable server                                                            | **HIGH**     | FIXED — missing pepper is now fatal                                                                                  |
| INFRA-04  | pnpm as PID 1: clean stop exits 1, zombies unreaped                                                                         | **MEDIUM**   | FIXED — node execs as PID 1                                                                                          |
| INFRA-03  | No HEALTHCHECK in image or compose                                                                                          | **MEDIUM**   | FIXED — HEALTHCHECK on /api/v1/ping                                                                                  |
| SEC-B-01  | MCP Streamable-HTTP transport skips the SSRF guard on redirects/rebinding                                                   | **HIGH**     | FIXED — secureFetch on the Streamable transport                                                                      |
| SEC-B-08  | Production compose is mode 664 with three literal secrets                                                                   | **MEDIUM**   | PARTIAL — compose now 640; literal secrets remain, operator decision                                                 |
| PERF-03   | 28,639 unauthorized requests produced 4 log lines and 0 audit rows                                                          | **MEDIUM**   | FIXED — rate-limited denial counter                                                                                  |
| UI-04     | No visible focus indicator on primary navigation (WCAG 2.4.7)                                                               | **HIGH**     | FIXED — global :focus-visible, 5.7-8.5:1                                                                             |
| UI-06     | Disabled button text 1.06:1 in dark mode (AA needs 4.5:1)                                                                   | **HIGH**     | FIXED — dark 6.03:1, light 4.62:1                                                                                    |
| SEC-B-03  | docker-image-dockerhub.yml armed, pushes to upstream's namespace                                                            | **MEDIUM**   | FIXED — every job `if: false`                                                                                        |
| DATA-01   | `chat_flow.flowData` stored as a BLOB on one row; the driver returns a Buffer, `JSON.parse` fails, the canvas is unopenable | **HIGH**     | FIXED — entity transformer normalises Buffer→string; the one production row converted to text, content md5 identical |
| UI-07     | Brand primary #2196f3 with white text is 3.12:1 (AA needs 4.5)                                                              | **MEDIUM**   | OPEN — brand decision. #1976d2 gives 4.60:1, #1565c0 gives 5.75:1                                                    |
| CRED-01   | Production password written to 11 files on disk during QA                                                                   | **HIGH**     | SCRUBBED — rotate the password                                                                                       |

## Counts

-   Findings recorded: **27**
-   Fixed in PR #8: **13**
-   Open: **13**

## The pattern underneath

Four separate controls could not fail: the release gate (`skipped` accepted, tag-name injection),
`audit:export --verify` (exits 0 regardless), `credential:rotate-encryption` (compared key versions,
not key identity), and the Dockerfile version assertion (only fires when the argument the docs omit
is passed). Three verifications performed during the work had the same defect: `git push --dry-run`
against a protected branch, the IP allowlist tested from inside the allowlist, and the release gate
tested only with a cooperative tag name.
The rule adopted in response: **a guard ships with a test that feeds it the bad input and asserts
refusal.** See `packages/server/test/security/negative-controls.test.ts`.

## 2026-11-09 — runtime and workspace security source reconciliation

Node 22.23.4, pnpm 10.34.5 and the dependency lockfile now align with the tested runtime strategy. Existing workspace credential guards are preserved. Local lint, full build, test discovery and all 3,597 tests in 157 suites pass. The TTS authorization regression fails before the fix and passes afterward. Docker image validation and GitHub CI remain pending. See [the dated security brief](security/2026-11-09-runtime-dependencies.md) for provenance and limitations.

## 2026-11-12 — Internal chat-history permission gate

The internal chat-message GET routes now require `chatflows:view` or
`agentflows:view`, using the same existing permission middleware as ordinary
chat history. A workspace API key with unrelated or empty grants previously
reached the message handler. The controller's workspace restriction remains
unchanged; this correction adds the missing operation-level permission check.

Fourteen synthetic route tests cover both registered paths, anonymous and
insufficiently privileged subjects, missing workspace scope, both viewer grants
and the existing organization-administrator behavior. The unfixed route fails
eight denial assertions; the fixed route passes all fourteen tests. No real
chat history, credentials, provider calls or production mutations are involved.

This is the internal-history portion of
[GHSA-ppmg-4cx6-95hh](https://github.com/FlowiseAI/Flowise/security/advisories/GHSA-ppmg-4cx6-95hh).
Ordinary history reads and deletion already have guards in this fork. Source
validation is distinct from runtime deployment; a rebuilt, verified image is
required before calling the production finding resolved. This is an
authorization disclosure risk, not demonstrated remote code execution.

## 2026-11-12 — Object-valued parameter override authorization

Object-valued overrides now require the same explicit node-label/parameter
permission as arrays and scalars before either scoped or unscoped merging. An
unscoped object previously fell through to the generic merge even when the
parameter was disabled, unlisted, or enabled only for a different node label.
The global API-override switch at the call sites remains in force. Variable
overrides retain their separate allowlist, and analytics retains its existing
explicit exception.

Nineteen synthetic helper tests exercise the actual production declaration,
including disabled input shapes, permission isolation, allowed object/array
merges and the existing exceptions. Four denial assertions fail on the original
helper; all nineteen pass with the guard. No live graph or provider is exercised.
This is a parameter-authorization defect; no public RCE was demonstrated. Source
validation and deployment are tracked separately. See
[the security note](security/2026-11-12-object-override-authorization.md).

## Addendum — 2026-11-13, found while writing the versioning test suite (I-03)

The table above is the fw8 point-in-time record. These two were found at 4.0.1 and are tracked in full in `ISSUE-REGISTER.md`.

| ID   | Finding                                                                                   | Severity | Status |
| ---- | ----------------------------------------------------------------------------------------- | -------- | ------ |
| I-34 | Flow history could include a commit belonging to a different flow when cut off by `limit` | MEDIUM   | FIXED  |
| I-35 | Prompt-focused diff returned hunks containing no changes                                  | LOW      | FIXED  |

Severity for I-34 is on demonstrated impact: commit subject and author identity of another flow's
save, reproduced in a test; flow content was not reachable by this path.
