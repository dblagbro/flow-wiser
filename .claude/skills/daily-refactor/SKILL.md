---
name: daily-refactor
description: Small, bounded cleanup that preserves behavior — dead code, duplication, naming, doc drift, missing registrations. Use for routine tidying of recent changes. For a large planned restructure use master-refactor instead.
---

# daily-refactor

One session's worth of low-risk cleanup. **Behaviour must not change.** If it does, it is not a
refactor and belongs in a different workflow.

## 1. Orient

Read `AGENTS.md`, `docs/index.md`, `docs/refactor-log.md`, and `.claude/rules/` entries matching
the paths in scope. Then:

```bash
cd /mnt/s/code/flow-wiser
git status --porcelain && git rev-parse --abbrev-ref HEAD && git log --oneline -5
```

If the tree is dirty with work you did not create, **stop and report it.** Never stash, reset or
commit over someone else's work.

## 2. Scope

Default scope is what changed recently:

```bash
git diff --name-only HEAD~5..HEAD | sort -u
```

Keep it to one coherent area. Candidates:

-   Dead code, unused exports, unreachable branches
-   Duplication that has an obvious existing helper
-   Naming that contradicts `AGENTS.md §4`
-   Formatting drift (`pnpm format`) — only in files you are already touching
-   **Missing structural registrations**: an entity absent from `database/entities/index.ts`,
    a route group not mounted in `routes/index.ts`, a migration present for some engines but not
    all four. These are correctness bugs wearing a tidiness costume — fix them, and add a test.
-   Documentation contradicting code, where intent is unambiguous

**Out of scope here** — send these elsewhere: behaviour changes, security fixes
(`remediate`), architectural moves (`master-refactor`), anything in `identity/rbac/` that
changes who can do what, and **any licensing claim**.

## 3. Execute

Use the **implementer** agent if `.claude/agents/implementer.md` exists; otherwise do it inline
under the same rules. Either way:

-   Establish current behaviour with a test **before** restructuring anything non-trivial.
-   One concern per commit. Never mix a refactor with a behaviour change.
-   Do not reformat files you are not otherwise changing — it destroys `git blame` for no gain.
-   Never touch `packages/server/src/enterprise/**` or `IdentityManager.ts`.

## 4. Verify

```bash
pnpm lint && pnpm build && pnpm test
node scripts/assert-test-discovery.js
```

If the toolchain cannot run (see `docs/testing.md`), **say so explicitly and report FAIL or
BLOCKED** — never describe an unverified refactor as passing. Verification is the entire
justification for a refactor; without it you have only churn.

## 5. Reconcile and record

-   Update `docs/project-map.md` if structure moved.
-   Append a dated entry to `docs/refactor-log.md`: what changed, why, what verified it.
-   If you found drift you did **not** fix, add it to `docs/remediation-plan.md`.

## 6. Stop before

Pushing, publishing, deploying, destructive database actions, or changing CI publish jobs.
Prepare and hand over the exact command instead. See `AGENTS.md §11`.

## 7. Report

```
DAILY REFACTOR — <date>
Scope      <area>
Changed    <path:line list>
Verified   <commands run + real result, or why not runnable>
Docs       <files updated>
Deferred   <what you left, and where you recorded it>

STATUS: PASS | FAIL — <reason> | BLOCKED — <need> | REVIEW REQUIRED — <decision>
```
