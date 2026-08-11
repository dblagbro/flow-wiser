# Project map

**Last updated: 2026-08-11** · **Mapped at:** `apache2-only` @ `ffae9952` · **Version:** `3.1.4-fw10`

Structural map of the repository. Counts are observed, not asserted — regenerate this document
when structure changes (`daily-refactor` and `master-refactor` are responsible for that).

## Surface inventory

| Surface                                          | Count                |
| ------------------------------------------------ | -------------------- |
| Workspace packages                               | 6                    |
| Server route groups                              | 62                   |
| Identity route files                             | 6                    |
| Controllers                                      | 49                   |
| Services                                         | 43                   |
| Database entities                                | 23 files             |
| Migrations — sqlite / postgres / mysql / mariadb | 53 / 55 / 57 / 56 ⚠️ |
| CLI command groups                               | 6                    |
| UI view directories                              | 29                   |
| UI route files                                   | 9                    |
| Test files                                       | 156                  |
| GitHub Actions workflows                         | 11                   |
| Kubernetes / Helm / Terraform manifests          | **0**                |

⚠️ **Migration counts are not equal across engines.** `AGENTS.md §5` requires a migration to be
added for all four. Some of this spread may be legitimately engine-specific and inherited from
upstream. **Unverified** — tracked in `remediation-plan.md`; do not treat as either a defect or
a non-issue until someone confirms which.

## Entry points

| Entry                  | Path                                                |
| ---------------------- | --------------------------------------------------- |
| Server process         | `packages/server/src/index.ts`                      |
| CLI / process launcher | `packages/server/bin/run` → `src/commands/start.ts` |
| Queue worker           | `src/commands/worker.ts` (`pnpm start-worker`)      |
| UI dev server          | `packages/ui` — Vite (`pnpm dev`)                   |
| Container              | `Dockerfile`, `docker/Dockerfile`                   |

## Packages and dependency direction

```
ui ──HTTP──▶ server ──▶ components ──▶ agentflow, observe
                └──▶ api-documentation
```

| Package                      | npm name               | Role                                                      |
| ---------------------------- | ---------------------- | --------------------------------------------------------- |
| `packages/server`            | `flowise`              | Express API, oclif CLI, TypeORM, queues, identity         |
| `packages/ui`                | `flowise-ui`           | React + Vite SPA — Apache-2.0, kept essentially unchanged |
| `packages/components`        | `flowise-components`   | Node/integration library                                  |
| `packages/agentflow`         | `@flowiseai/agentflow` | Agent flow runtime (published separately)                 |
| `packages/observe`           | `@flowiseai/observe`   | Observability (published separately)                      |
| `packages/api-documentation` | `flowise-api`          | API documentation                                         |

**Never** introduce `components → server`, and never let the UI import server internals.

## APIs and contracts

-   **62 route groups** under `packages/server/src/routes/<kebab-case>/`, all mounted in
    `routes/index.ts`. Base path `/api/v1/`.
-   Notable groups: `predictions`, `internal-predictions`, `chatflows`, `chatflows-streaming`,
    `public-chatflows`, `public-chatbots`, `public-executions`, `credentials`, `variables`,
    `documentstore`, `vectors`, `upsert-history`, `executions`, `evaluations`, `mcp-server`,
    `mcp-endpoint`, `oauth2`, `openai-*`, `webhook`, `webhook-listener`, `flow-versions`,
    `export-import`, `leads`, `ping`, `settings`, `stats`.
-   **Public/unauthenticated groups are the highest-risk surface here** — `public-chatbots`,
    `public-chatflows`, `public-executions`, `leads`, `webhook-listener`. Historic critical
    findings live in this area; treat any change to them as security-relevant.

## Authentication and authorization

The Apache-2.0 clean-room replacement, at `packages/server/src/identity/`:

| Path                               | Role                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `identity/PlatformManager.ts`      | `IdentityManager` — the replacement platform entry point               |
| `identity/rbac/Permissions.ts`     | permission catalog                                                     |
| `identity/rbac/PermissionCheck.ts` | server-side enforcement                                                |
| `identity/rbac/types.ts`           | RBAC types                                                             |
| `identity/tenancy/`                | workspace / organization scoping                                       |
| `identity/crypto/`                 | hashing, encryption                                                    |
| `identity/middleware/`             | session and authorization middleware                                   |
| `identity/services/`               | incl. `BootstrapService.ts` — seeds roles at first run                 |
| `identity/routes/`                 | `auth`, `account`, `mfa`, `loginMethod`, `workspace`, `notImplemented` |

Wiring is **confirmed**: imported and mounted in `routes/index.ts:64–72`; identity entities
exported from `database/entities/index.ts:39`.

`packages/server/src/enterprise/` and `IdentityManager.ts` — the commercially-licensed paths —
**do not exist in this tree**. The prohibition on reading them still applies to every branch,
tag and historical commit (`AGENTS.md §0`).

## Persistence

-   TypeORM. Engines: **sqlite, postgres, mysql, mariadb**.
-   Entities: `packages/server/src/database/entities/` (23 files), registered in `entities/index.ts`.
    Identity entities use `identity_`-prefixed tables.
-   Migrations: `database/migrations/<engine>/` — see the count caveat above.
-   Migration tooling: `database/migration-tool/`.
-   **SQLite is single-writer and does not survive horizontal scaling** — Postgres is required
    before running replicas. See `platform-roadmap.md`.

## Queues and async processing

`packages/server/src/queue/` — BullMQ over Redis.

| File                                                 | Role                 |
| ---------------------------------------------------- | -------------------- |
| `QueueManager.ts`, `BaseQueue.ts`                    | queue lifecycle      |
| `PredictionQueue.ts`                                 | prediction execution |
| `UpsertQueue.ts`                                     | vector upserts       |
| `ScheduleQueue.ts`                                   | scheduled runs       |
| `RedisEventPublisher.ts` / `RedisEventSubscriber.ts` | cross-process events |

Also: `AbortControllerPool.ts`, `CachePool.ts`, `NodesPool.ts`, `schedule/`, `metrics/`.

## UI

React + Vite SPA. 29 view directories under `packages/ui/src/views/`. Routing in
`packages/ui/src/routes/`: `MainRoutes`, `AuthRoutes`, `CanvasRoutes`, `ChatbotRoutes`,
`ExecutionRoutes`, plus `RequireAuth.jsx`, `RouteErrorBoundary.jsx`, `DefaultRedirect.jsx`.

**Standing requirement: keep this essentially unchanged.** It is Apache-2.0 and carries the
complete HTTP contract the clean-room specification was derived from.

## CLI

oclif, `packages/server/src/commands/`: `admin/`, `audit/`, `credential/`, `mfa/`, `session/`,
`sso/`, plus `doctor.ts`, `start.ts`, `worker.ts`, `base.ts`, `recovery-base.ts`.

## Configuration

`AppConfig.ts`, environment variables, `.env.example` per package. Security-critical:

-   `FLOWISE_SECRETKEY_OVERWRITE` — **must never** be the `.env.example` default
-   `FLOWISE_SESSION_PEPPER` — absence is fatal at boot, by design
-   Database, Redis, and queue-mode variables

## Deployment and infrastructure

-   `Dockerfile`, `docker/Dockerfile`, `docker/worker/`
-   `docker/docker-compose.yml`, `docker-compose-queue-source.yml`,
    `docker-compose-queue-prebuilt.yml`
-   11 GitHub Actions workflows, including `cleanroom-guard.yml`, `proprietary-path-guard.yml`,
    `release-gate.yml`, `main.yml`, `test_docker_build.yml`, and 4 publish workflows
-   `.githooks/pre-commit` (clean-room guard), `.husky/pre-commit`, `.husky/pre-push`
-   **No Kubernetes, Helm or Terraform.** A coverage limit, not a pass.

## Tests

156 test files, colocated `*.test.ts` beside the unit under test.
`scripts/assert-test-discovery.js` asserts no suite is silently unrun.

## Ownership and change risk

| Area                      | Risk                                     | Rule                                                  |
| ------------------------- | ---------------------------------------- | ----------------------------------------------------- |
| `identity/**`             | **licence-critical + security-critical** | clean-room rules; server-side enforcement; audited    |
| public/unauth routes      | **security-critical**                    | assume hostile input; historic critical findings here |
| `database/migrations/**`  | data loss                                | all four engines; verify up _and_ down                |
| `docker/**`, `Dockerfile` | silent mis-ship                          | keep pinning + installed-equals-requested assertion   |
| `.github/workflows/**`    | control integrity                        | no publish/gate change without authorization          |
| `packages/ui/**`          | product requirement                      | keep essentially unchanged                            |
| `upstream-archive/**`     | reference only                           | never build from; must stay `.dockerignore`d          |
