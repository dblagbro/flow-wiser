# Architecture

**Last updated: 2026-08-11** · **Observed at:** `apache2-only` @ `ffae9952`

Module boundaries and the rules that hold them. The structural inventory lives in
[`project-map.md`](project-map.md); this document explains _why_ the boundaries are where they are.

## Shape

A pnpm + turbo monorepo. A single Express server hosts the API, an oclif CLI and the
TypeORM data layer; a React/Vite SPA talks to it over HTTP only; a component library supplies
the node/integration catalog.

```
                    ┌─────────────┐
   browser ────────▶│  packages/  │   React + Vite SPA
                    │     ui      │   Apache-2.0 · keep essentially unchanged
                    └──────┬──────┘
                           │  HTTP  /api/v1/*   ← the only coupling
                    ┌──────▼──────────────────────────────┐
                    │        packages/server              │
                    │  routes ▸ controllers ▸ services    │
                    │  identity/  (authn · rbac · tenancy)│
                    │  database/  (TypeORM · 4 engines)   │
                    │  queue/     (BullMQ · Redis)        │
                    │  commands/  (oclif CLI)             │
                    └──────┬──────────────────────────────┘
                           │
                    ┌──────▼──────┐
                    │ components  │ ──▶ agentflow, observe
                    └─────────────┘
```

## Dependency direction — enforced

```
ui ──HTTP──▶ server ──▶ components ──▶ agentflow, observe
```

Two rules, both load-bearing:

-   **Never `components → server`.** The component library must stay independently publishable and
    free of server internals. A cycle here makes both unpublishable.
-   **Never `ui → server` by import.** The UI's only coupling is the HTTP contract. This is not
    merely hygiene: `packages/ui` being pure Apache-2.0, with the complete HTTP contract expressed
    in it, is precisely what made the clean-room specification derivable without ever reading a
    licensed file. Compromising that boundary would damage the project's legal position, not just
    its architecture.

Inverting either needs an ADR arguing why.

## The licence boundary

The defining architectural constraint. FlowiseAI's commercially-licensed subsystem —
`packages/server/src/enterprise/**` and `IdentityManager.ts` — was **not** refactored, ported or
translated. It was specified from Apache-2.0 sources only, reimplemented independently, and the
originals deleted.

-   Replacement lives at `packages/server/src/identity/`.
-   Identity tables are `identity_`-prefixed so old and new could coexist during cut-over without
    the running server being affected.
-   The prohibition on **reading** those paths survives their deletion — it applies to every
    branch, tag, historical commit and restored copy (`AGENTS.md §0`).

At `ffae9952` those paths are absent and `identity/` is wired in. See
[`current-state.md`](current-state.md) for exactly what was observed, and why that is not the
same as a licensing determination.

## Identity layer

| Concern                  | Location                                | Rule                                                 |
| ------------------------ | --------------------------------------- | ---------------------------------------------------- |
| Permission catalog       | `identity/rbac/Permissions.ts`          | single source of truth                               |
| Enforcement              | `identity/rbac/PermissionCheck.ts`      | **server-side, deny by default**                     |
| Tenancy                  | `identity/tenancy/`                     | every query workspace/organization-scoped            |
| Crypto                   | `identity/crypto/`                      | hashing, encryption at rest                          |
| Session/authz middleware | `identity/middleware/`                  | applied by default, not opt-in                       |
| Bootstrap                | `identity/services/BootstrapService.ts` | seeds roles at first run                             |
| HTTP                     | `identity/routes/`                      | `auth`, `account`, `mfa`, `loginMethod`, `workspace` |

**A UI-only check is not a permission.** Upstream's cosmetic checks — rendering a button as
`null` with no server-side counterpart — are the specific defect this layer exists to correct.
Deny-by-default means a route added without an explicit permission must fail closed, not open.

## Data layer

TypeORM across **four engines**: sqlite, postgres, mysql, mariadb. A migration is part of a
change only when it exists for all four.

-   **SQLite is single-writer.** It is fine for single-node deployment and does not survive
    horizontal scaling; Postgres is a precondition for replicas. See
    [`platform-roadmap.md`](platform-roadmap.md).
-   Entities must be registered in `database/entities/index.ts` — an unregistered entity is
    invisible to TypeORM and fails at runtime, not at build.
-   Migrations run at startup; concurrent replicas racing on migration is an open topology concern.

## Async and scaling

`queue/` provides BullMQ-over-Redis queues for predictions, upserts and schedules, with Redis
pub/sub for cross-process events. Queue mode lets the API and workers scale independently — see
`docker/docker-compose-queue-*.yml`. Without it the server runs everything in-process.

## Request path

```
HTTP ▸ middleware (session, authz, tenancy) ▸ routes/<group> ▸ controllers ▸ services
     ▸ database (TypeORM) | queue (BullMQ) ▸ components (node execution)
```

Authorization belongs in middleware and the RBAC layer, **not** in controllers. A check written
inline in one controller is a check the next route will not inherit — which is how routes end up
unauthenticated. The `public-*` groups are the deliberate, audited exceptions and must be treated
as hostile-input surfaces.

## Build and release

turbo orchestrates per-package `build`/`test`. Containers build from `docker/Dockerfile` with the
version passed as a **build arg** so it participates in the layer cache key, plus an assertion
that the installed version equals the requested one. That assertion is not optional: an unpinned
`npm install -g flowise` is the exact defect that shipped three mislabelled images, and it failed
silently because a stale-but-working install is indistinguishable from a fresh one.

## Architectural rules

1. Preserve behaviour during refactoring; behaviour changes are a different kind of change.
2. Never read or edit the licensed paths; deletion only.
3. Keep `packages/ui` essentially unchanged.
4. No `components → server`; no `ui → server` imports.
5. Authorization is server-side, deny-by-default, workspace-scoped, audited.
6. A migration exists for all four engines or it does not exist.
7. Anything participating in a cache key is pinned, and the pin is asserted **after** all
   mutations — not per step.
8. New top-level directories need an ADR.
