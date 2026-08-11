---
name: master-refactor
description: Large, planned, multi-stage restructuring — module boundaries, migrations, cut-overs, systematic pattern changes across many files. Plans first and gets sign-off before implementing. Use daily-refactor for routine cleanup.
---

# master-refactor

A staged restructure that stays reviewable at every point. **Plan and get approval before
implementing.** Behaviour is preserved throughout unless a change is explicitly authorized as a
behaviour change, in which case it is not part of the refactor.

## 1. Orient

Read `AGENTS.md`, `docs/index.md`, `docs/architecture.md`, `docs/project-map.md`,
`docs/decisions/`, `docs/refactor-log.md`, and the relevant `docs/REQUIREMENTS-*.md`.
Read `docs/decisions/` carefully — do not re-propose something already decided or rejected.

```bash
cd /mnt/s/code/flow-wiser
git status --porcelain && git rev-parse --abbrev-ref HEAD && git log --oneline -10
```

Require a clean tree. If it is dirty, stop and report — do not stash.

## 2. Map current state

Use the **cartographer** agent if available (verify `.claude/agents/cartographer.md` exists),
otherwise inline. Establish real structure from the code, not from documents, and record where
the two disagree — that gap is usually the most important finding.

## 3. Plan

Use the **architect** agent if available; otherwise plan inline to the same standard. The plan must give:

-   Current state, with paths
-   Target state, and why it is better
-   **Ordered stages**, each independently reviewable, each with its own verification
-   The cut-over point, and how to reverse it
-   Risks: behaviour change, data loss, licensing, production, remote systems
-   Which stages can land independently, and which must be atomic

Constraints the plan must respect:

-   Never read or edit `packages/server/src/enterprise/**` or `IdentityManager.ts`; deletion only
-   Keep `packages/ui` essentially unchanged — a standing product requirement
-   Preserve the dependency direction in `AGENTS.md §2`
-   A migration added for one engine is added for **all four**
-   Permissions are enforced server-side; a UI-only check is not a permission

**Present the plan and stop for approval before implementing.** A large restructure begun
without sign-off is the most expensive mistake available here.

## 4. Implement, stage by stage

For each approved stage, using the **implementer** agent if available:

1. Characterisation tests capturing current behaviour, **before** touching anything
2. The change, in the smallest reviewable unit
3. `pnpm lint && pnpm build && pnpm test` + `node scripts/assert-test-discovery.js`
4. A dated entry in `docs/refactor-log.md`
5. Stop and report at each stage boundary — do not run stages together

If any stage fails verification, **stop the whole refactor** and report. Do not proceed on the
assumption that a later stage will fix it.

## 5. Reconcile

Update `docs/architecture.md`, `docs/project-map.md`, `docs/current-state.md` and `CHANGELOG.md`.
Write an ADR in `docs/decisions/` for the decision itself — this is by definition significant.

## 6. Stop before

Pushing, publishing, deploying, destructive database actions, weakening any guard or CI check.
Prepare and hand over. See `AGENTS.md §11`.

## 7. Report

```
MASTER REFACTOR — <date>
Plan       <n> stages, approved <yes/no>
Completed  <stage list with verification result>
Remaining  <stages not yet done>
Behaviour  PRESERVED | CHANGED — <what, and under whose authorization>
Docs/ADR   <files written>

STATUS: PASS | FAIL — <stage + reason> | BLOCKED — <need> | REVIEW REQUIRED — <decision>
```
