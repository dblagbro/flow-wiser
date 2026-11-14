---
description: Database entities and migrations — four-engine parity and data-loss rules
globs:
    - 'packages/server/src/database/**'
alwaysApply: false
---

# Database changes

## Four engines, always

Migrations exist for **sqlite, postgres, mysql, mariadb**. A migration added for one engine and
not the others is not a migration — it is a latent production failure on whichever engine was
skipped.

```
packages/server/src/database/migrations/{sqlite,postgres,mysql,mariadb}/
```

Verify each one runs **up and down** on its engine before considering the change done.

> The directories hold **52 / 54 / 56 / 55** migrations and that is correct: 52 are shared by all
> four engines, and six are engine-specific corrections, each declared with its reason in
> `packages/server/test/database/migration-parity.test.ts` (RM-07, verified 2026-11-13). That test
> fails on any other difference. A genuinely engine-specific migration is added by declaring it
> there — never by generating stubs for the other engines, and never silently.

## Entities

-   Register every new entity in `database/entities/index.ts`. An unregistered entity is invisible
    to TypeORM and fails **at runtime, not at build** — the worst place to find out.
-   Identity-layer tables are `identity_`-prefixed.
-   Use portable column types. Date/time handling differs across the four engines and has broken
    here before.
-   Set the tenancy key on **every** create path. A row created with a null `organizationId` passes
    its own insert and fails the health check later, far from the cause.

## Data safety

**Never**, without explicit per-occasion authorization: drop or truncate a table, mass-delete
rows, run a destructive or irreversible migration, or run any migration against production.

-   Deleting a referenced row is not safe just because the delete succeeds. Flows bind credentials
    by UUID — a delete-and-recreate silently orphaned 37 references across 21 flows and took down a
    live chatbot. Check inbound references before removing anything.
-   Every migration needs a working `down()`. Test it.
-   Migrations currently run at startup; concurrent replicas racing on them is an unresolved
    topology concern (`docs/platform-roadmap.md`). Do not add a migration that assumes a single
    writer without saying so.

## Required for every change here

1. Migrations for all four engines, or a written justification for why an engine is excluded.
2. Up and down both verified.
3. Entity registered in `entities/index.ts`.
4. A test covering the new shape.
5. `docs/project-map.md` updated if counts or structure changed.
