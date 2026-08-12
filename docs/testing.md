# Test plan and coverage — `3.1.4-fw8-rc2`

**Run started:** 2026-08-09 · **Status:** Phase 2 in progress

## Release target under test

| | |
|---|---|
| Commit | `7f73fda0` on `fix/open-core-route-gating` (PR #8, CI green, **held unmerged** pending this QA) |
| `main` | `0536d687` |
| Version | `3.1.4-fw8` |
| Image | `dblagbro/flow-wiser:3.1.4-fw8-rc2`, id `sha256:d679bfc79de9…` |
| Deployed | production `flowise` container is running this candidate |

Release, tag, Docker Hub publication and the PR merge are **blocked on this QA completing**.

## Environments

| Env | Where | Mutating tests | Purpose |
|---|---|---|---|
| **PROD** | `flowise` :3000, `https://www.voipguru.org` | **NO — read-only, GET only** | Confirm behaviour matches; 25 real chatflows, 3 real credentials, real chat history |
| **QA-API** | `fw-qa` :3100, fresh DB, own volume | yes | API, security, ops, CLI, backup/restore |
| **QA-UI** | `fw-qa-ui` :3101, fresh DB, own volume | yes | UI/accessibility — separate so `session:revoke-all` testing cannot kill its sessions |

Both QA instances are standalone `docker run` containers, deliberately **not** part of the compose
stack, so they cannot affect the other ~113 services on this host.

**Production integrity control:** the production database was fingerprinted before QA began
(`md5 07feec275533883d81370b6ef0e15ca3`) and is re-checked at teardown. If it changed, this QA run
violated its own rules and the result is suspect.

## Surface inventory

| Surface | Count | Domain |
|---|---|---|
| Server route groups | 62 | API |
| Identity route files | 6 | API / Security |
| CLI commands | 16 | Ops |
| SQLite migrations | 53 | Static |
| Test files | 245 | Static |
| UI routes | 36 declared / 23 walked | UI |
| Compose services on host | 113 (only `flowise` in scope) | Infra |
| Kubernetes / Terraform / IaC | **0 — none in this repo** | *coverage limit, not tested* |

## Domains and coverage matrix

| ID | Domain | Environment | Key questions |
|---|---|---|---|
| STATIC | Build, lint, types, tests, migrations, dependencies, doc commands | repo | Does it build clean from scratch? Do all 245 test files actually run? Do the 53 migrations agree across engines? |
| API | Endpoints, authz, tenancy, input handling, error hygiene | QA-API | Is there cross-tenant IDOR? Does unauth prediction execute? Do credentials redact? |
| SEC | Sandbox, crypto, secrets, headers, SSRF, supply chain, authn | QA-API + source | Can the `vm2` denylist be bypassed? Does `CODE_EXECUTION_MODE=disabled` block every path? Are the compliance claims true? |
| INFRA | Dockerfile, image, SBOM, compose, runtime failure modes | image + QA-API | Does the licence guard pass vacuously? Is the `ui-build` bind-mount dead config? |
| OPS | 16 CLI commands, `doctor`, key rotation, audit export/prune, **backup + restore rehearsal** | QA-API | Can a backup actually be restored? Is rotation atomic under interruption? |
| UI | Routes, browsers, viewports, themes, a11y, states, forms | QA-UI + PROD read-only | Did the `/unauthorized` fix hold? Do pages render usable content, not just 200? |

## Known-going-in, not to be re-reported as discoveries

- `vm2` is the default execution path; escapes blocked by configuration, not architecture.
- `/users`, `/roles`, `/login-activity` call deliberate `501` stubs — no backend in this build.
- `/account` calls `/api/v1/user` (501); `/marketplaces` throws `500` on `/api/v1/node-icon/csvAgent`.
- Production `doctor` exits 1 on 12 dangling credential references — operator data, not a defect.
- Two unrelated domains on the shared edge have expired TLS certificates (since 2026-03-18).

## Destructive boundaries

Stop and ask before: anything mutating production data, `docker compose down`/`down -v`, volume
removal, any prune, cloud `apply`, load testing against production, or intrusive security testing
against anything not owned by the operator.

## Artifacts

Every artifact created for this run is logged in `scratchpad/QA-ARTIFACTS.md` as it is created, with
a matching teardown script written **before** testing began rather than after, so nothing depends on
remembering what was made.
