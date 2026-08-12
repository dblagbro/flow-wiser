---
name: daily-qa
description: Quick verification pass over recent changes — lint, build, tests, test discovery, and targeted checks on what actually changed. Use before handing work over or at the end of a working session. For a full release-grade sweep use master-qa.
---

# daily-qa

Fast confidence in what changed today. Not a release gate — `master-qa` and
`final-release-gate` are for that.

## 1. Orient

Read `AGENTS.md`, `docs/testing.md`, `docs/bug-log.md`.

```bash
cd /mnt/s/code/flow-wiser
git status --porcelain && git rev-parse --abbrev-ref HEAD
git diff --name-only HEAD~5..HEAD | sort -u
```

## 2. Static gates

```bash
pnpm lint
pnpm build
pnpm test
node scripts/assert-test-discovery.js
```

Run them; do not reason about them. Paste real output for anything that fails.

**If the toolchain cannot run** (no pnpm, wrong Node — see `docs/testing.md` and `CLAUDE.md`),
report `BLOCKED` and say precisely which gates were not executed. Do **not** substitute reading
the code for running the tests and then report PASS. An unrun gate is not a passed gate.

## 3. Targeted checks on the diff

For each changed area, verify the project's structural invariants:

| If the change touched         | Check                                                                 |
| ----------------------------- | --------------------------------------------------------------------- |
| `database/entities/`          | registered in `entities/index.ts`                                     |
| `database/migrations/`        | present for **all four** engines, numerically aligned                 |
| `routes/`                     | mounted in `routes/index.ts`; authenticated and authorized by default |
| `identity/rbac/`              | enforced server-side, deny-by-default, workspace-scoped, audited      |
| any bug fix                   | ships a test that **fails before** and passes after                   |
| any security fix              | ships a **negative** test reproducing the original condition          |
| `docker/`, `Dockerfile`       | version pinning and the installed-equals-requested assertion intact   |
| public/unauthenticated routes | genuinely intended to be public; no private object leaks              |

Use the **qa-engineer** agent if `.claude/agents/qa-engineer.md` exists; otherwise inline.

## 4. Hard rules

-   **Production is read-only.** GET only, never a mutating request, never a restart.
-   Never `docker compose down`, remove volumes, or stop a stack. Named disposable containers only.
-   Never read `flowise-credentials-backup-*.json`, `.env`, `*.sqlite`, `*.pem`, `*.key`.
-   Never put a real secret in a test or fixture.

## 5. Record

Append a dated entry to `docs/qa-notes.md`. Any new defect goes in `docs/bug-log.md` with
severity based on **demonstrated** impact, and marked latent where it is latent.

## 6. Report

```
DAILY QA — <date>
Scope     <commit range / area>
Gates     lint <r> · build <r> · test <r> · discovery <r>   (or NOT RUN — <why>)
Checks    <invariant: result, one line each>
New       <defects found>
Docs      <files updated>

STATUS: PASS | FAIL — <n> findings | BLOCKED — <what could not run> | REVIEW REQUIRED — <decision>
```
