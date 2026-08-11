# Test plan and coverage — `3.1.4-fw8-rc2`

**Run started:** 2026-08-09 · **Status:** Phase 2 in progress

## Release target under test

|          |                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------- |
| Commit   | `7f73fda0` on `fix/open-core-route-gating` (PR #8, CI green, **held unmerged** pending this QA) |
| `main`   | `0536d687`                                                                                      |
| Version  | `3.1.4-fw8`                                                                                     |
| Image    | `dblagbro/flow-wiser:3.1.4-fw8-rc2`, id `sha256:d679bfc79de9…`                                  |
| Deployed | production `flowise` container is running this candidate                                        |

Release, tag, Docker Hub publication and the PR merge are **blocked on this QA completing**.

## Environments

| Env        | Where                                       | Mutating tests               | Purpose                                                                              |
| ---------- | ------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| **PROD**   | `flowise` :3000, `https://www.voipguru.org` | **NO — read-only, GET only** | Confirm behaviour matches; 25 real chatflows, 3 real credentials, real chat history  |
| **QA-API** | `fw-qa` :3100, fresh DB, own volume         | yes                          | API, security, ops, CLI, backup/restore                                              |
| **QA-UI**  | `fw-qa-ui` :3101, fresh DB, own volume      | yes                          | UI/accessibility — separate so `session:revoke-all` testing cannot kill its sessions |

Both QA instances are standalone `docker run` containers, deliberately **not** part of the compose
stack, so they cannot affect the other ~113 services on this host.

**Production integrity control:** the production database was fingerprinted before QA began
(`md5 07feec275533883d81370b6ef0e15ca3`) and is re-checked at teardown. If it changed, this QA run
violated its own rules and the result is suspect.

## Surface inventory

| Surface                      | Count                         | Domain                       |
| ---------------------------- | ----------------------------- | ---------------------------- |
| Server route groups          | 62                            | API                          |
| Identity route files         | 6                             | API / Security               |
| CLI commands                 | 16                            | Ops                          |
| SQLite migrations            | 53                            | Static                       |
| Test files                   | 245                           | Static                       |
| UI routes                    | 36 declared / 23 walked       | UI                           |
| Compose services on host     | 113 (only `flowise` in scope) | Infra                        |
| Kubernetes / Terraform / IaC | **0 — none in this repo**     | _coverage limit, not tested_ |

## Domains and coverage matrix

| ID     | Domain                                                                                      | Environment            | Key questions                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| STATIC | Build, lint, types, tests, migrations, dependencies, doc commands                           | repo                   | Does it build clean from scratch? Do all 245 test files actually run? Do the 53 migrations agree across engines?          |
| API    | Endpoints, authz, tenancy, input handling, error hygiene                                    | QA-API                 | Is there cross-tenant IDOR? Does unauth prediction execute? Do credentials redact?                                        |
| SEC    | Sandbox, crypto, secrets, headers, SSRF, supply chain, authn                                | QA-API + source        | Can the `vm2` denylist be bypassed? Does `CODE_EXECUTION_MODE=disabled` block every path? Are the compliance claims true? |
| INFRA  | Dockerfile, image, SBOM, compose, runtime failure modes                                     | image + QA-API         | Does the licence guard pass vacuously? Is the `ui-build` bind-mount dead config?                                          |
| OPS    | 16 CLI commands, `doctor`, key rotation, audit export/prune, **backup + restore rehearsal** | QA-API                 | Can a backup actually be restored? Is rotation atomic under interruption?                                                 |
| UI     | Routes, browsers, viewports, themes, a11y, states, forms                                    | QA-UI + PROD read-only | Did the `/unauthorized` fix hold? Do pages render usable content, not just 200?                                           |

## Known-going-in, not to be re-reported as discoveries

-   `vm2` is the default execution path; escapes blocked by configuration, not architecture.
-   `/users`, `/roles`, `/login-activity` call deliberate `501` stubs — no backend in this build.
-   `/account` calls `/api/v1/user` (501); `/marketplaces` throws `500` on `/api/v1/node-icon/csvAgent`.
-   Production `doctor` exits 1 on 12 dangling credential references — operator data, not a defect.
-   Two unrelated domains on the shared edge have expired TLS certificates (since 2026-03-18).

## Destructive boundaries

Stop and ask before: anything mutating production data, `docker compose down`/`down -v`, volume
removal, any prune, cloud `apply`, load testing against production, or intrusive security testing
against anything not owned by the operator.

## Artifacts

Every artifact created for this run is logged in `scratchpad/QA-ARTIFACTS.md` as it is created, with
a matching teardown script written **before** testing began rather than after, so nothing depends on
remembering what was made.

---

# Toolchain verification — Node 22 · 2026-08-11

> Appended, not replacing the `3.1.4-fw8-rc2` plan above. This is a **static/toolchain** run only:
> no instance was started, no API, UI, ops or data domain was exercised, and **production was not
> contacted at all**. It establishes that the tree builds on Node 22 — nothing more.

**Under test:** `apache2-only` @ `ffae9952` (working tree, uncommitted Node-alignment changes),
version `3.1.4-fw10`. Toolchain: Node **v22.23.2**, pnpm **10.26.0**.
Context: [ADR-0004](decisions/ADR-0004-node-version-conflict.md).

## Results

| Gate                                    | Result         | Evidence                                                                                    |
| --------------------------------------- | -------------- | ------------------------------------------------------------------------------------------- |
| `pnpm install`                          | ✅ **PASS**    | exit 0, 8m 2.3s                                                                             |
| Native driver `sqlite3@5.1.7`           | ✅ **PASS**    | binding compiled; `require('sqlite3')` loads                                                |
| `pnpm build`                            | ✅ **PASS**    | exit 0, 3m34.6s — **6 of 6 packages**                                                       |
| Build artifacts                         | ✅ **PASS**    | `server/dist`, `ui/build`, `components/dist`, `agentflow/dist`, `observe/dist` all produced |
| `pnpm test` — all packages              | ✅ **PASS**    | **3,587 / 3,588** — see breakdown                                                           |
| `node scripts/assert-test-discovery.js` | ✅ **PASS**    | **156 / 156** discovered, exit 0 — no suite silently unrun                                  |
| `pnpm lint`                             | ✅ **PASS**    | exit 0 — **0 errors**, 16 pre-existing warnings                                             |
| Built CLI starts                        | ❌ **TIMEOUT** | see RM-14                                                                                   |
| Docker build / boot on Node 22          | ⬜ not yet run | RM-12                                                                                       |

**Lint found a live secret-exposure problem before it found any code problem.** `pnpm lint` globs
`**/*.json`, matched the credential export in the working directory and **opened it** — blocked
only by file permissions. Fixed and verified; see RM-16. The gate had never been run here, so this
had been sitting behind a "not yet run" line.

The 16 remaining warnings are pre-existing (unused imports in `chatflows/index.ts`, `no-explicit-any`
in agentflow tests, unused vars in two UI files). Warnings do not fail the gate and were left alone
rather than swept up as drive-by changes.

## Test results per package — Node 22

| Package                |  Suites |     Tests |       Time | Result                                   |
| ---------------------- | ------: | --------: | ---------: | ---------------------------------------- |
| `flowise` (server)     |      34 |       980 |      171 s | ✅ all pass                              |
| `flowise-components`   |      22 |       953 |      121 s | ✅ all pass                              |
| `@flowiseai/agentflow` |      73 |     1,255 |       98 s | ✅ all pass                              |
| `@flowiseai/observe`   |      25 |       335 | 2,242 s ⚠️ | 334 pass, **1 timeout** — RM-15          |
| `flowise-ui`           |       2 |        65 |        6 s | ✅ all pass                              |
| **Total**              | **156** | **3,588** |            | **3,587 pass / 1 environmental timeout** |

The one failure is `CodeFenceBlock › copy › does NOT flash "Copied!" when the clipboard write
rejects` — a 5,000 ms timeout under parallel workers that **passes in 26 ms** when run in isolation.
It is contention on NFS, not a defect. Diagnosis and the discarded hypothesis: RM-15.

**Run serially (`--runInBand`) these suites are fast** — server 980 tests in 171 s, agentflow 1,255
in 98 s. The 2,242 s figure for `observe` is from the parallel turbo run and is not representative
of the code.

**Correction to the `3.1.4-fw8` record above:** that run reported "980 tests". 980 is the
**server package alone**; the whole workspace is **3,588** across 156 suites. The earlier figure
was a per-package count presented as a total.

## Notes worth carrying forward

**`better-sqlite3` is not in this tree.** The historic "Node 24 cannot build — `better-sqlite3`
fails under node-gyp" finding refers to a package that is **not installed and not a declared
dependency**; it appears in `pnpm-lock.yaml` only within LangChain's optional peer-dependency list.
The SQLite driver actually used is `sqlite3@5.1.7`, which builds and loads on Node 22. Do not
repeat the old framing as current fact.

**pnpm's "ignored build scripts" warning is expected here.** `package.json` sets
`onlyBuiltDependencies: ["faiss-node", "sqlite3"]` — a deliberate minimal allowlist. The build
succeeds without widening it. **Do not run `pnpm approve-builds` to silence the warning**; see
RM-13.

**The built CLI did not start** from this NFS working copy — `node ./bin/run --version` was killed
at 300s having used 0.68s of user CPU (i.e. blocked on I/O, not computing). Probably an NFS
artifact rather than a regression, but **unproven**. Until RM-14 resolves it, any test that needs
to _run_ the server or CLI from this working copy should be expected to time out; unit tests are
unaffected because they do not start the CLI.

## Coverage limits

Nothing functional was tested. No API, security, UI, ops, data or infrastructure domain was
exercised; no instance was started. A green build is not a working release — see
[`release-readiness.md`](release-readiness.md) and RM-12.
