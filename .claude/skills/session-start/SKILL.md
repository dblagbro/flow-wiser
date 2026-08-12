---
name: session-start
description: Orient at the start of a working session on Flow-Wiser. Reports git state, toolchain readiness, active controls, open defects, drift between docs and code, and what to do next. Read-only. Use when starting work, resuming after a break, or when unsure of the current state.
---

# session-start

Establish what is actually true right now, before any work is planned. Nothing here mutates
the repository.

## 1. Read the contract

Read in order, and stop if a file is missing (report it):

-   `AGENTS.md`, `CLAUDE.md`
-   `docs/index.md` — the authority map; it tells you which document owns which topic
-   `docs/current-state.md`, `docs/bug-log.md`, `docs/remediation-plan.md`

## 2. Inspect git state

```bash
cd /mnt/s/code/flow-wiser
git rev-parse --abbrev-ref HEAD && git rev-parse --short HEAD
git status --porcelain
git log --oneline -8
git fetch --dry-run origin 2>&1 | head
git log --oneline HEAD..@{u} 2>/dev/null | head   # behind?
git log --oneline @{u}..HEAD 2>/dev/null | head   # ahead — unpushed work
git tag -l 'pre-methodology-*' 'v3.1.4-*' | tail -5
```

Report: branch, HEAD, dirty files, ahead/behind, and any uncommitted work. **Never** stash,
reset, checkout over, commit or push anything found here — report it and let the human decide.

## 3. Check the toolchain honestly

```bash
node -v; (pnpm -v 2>/dev/null || echo "pnpm: MISSING"); cat .nvmrc; jq -r '.engines' package.json
```

State plainly whether `pnpm build`, `pnpm test` and `pnpm lint` **can run at all**. If they
cannot, every downstream skill is limited to static analysis, and must say so rather than
implying verification happened.

## 4. Check which controls actually execute

Existence is not enforcement — `docs/PROCESS-GAPS.md` G1.

```bash
git config core.hooksPath || echo "core.hooksPath: UNSET -> .githooks/pre-commit does NOT run"
ls node_modules/.bin/husky >/dev/null 2>&1 || echo "husky: NOT INSTALLED -> .husky/* does NOT run"
grep -l "github.repository ==" .github/workflows/*.yml    # workflows gated to another repo
```

Report each control as **ACTIVE** or **INERT**, with the evidence.

## 5. Detect drift

Compare what the documents claim against what the tree shows. At minimum:

-   Version in `package.json` vs. the version `docs/current-state.md` and `docs/STATUS.md` describe
-   Whether `packages/server/src/enterprise/` and `IdentityManager.ts` exist
    (`ls -d` only — **never read them**)
-   Route groups on disk vs. those mounted in `routes/index.ts`
-   Migration counts across `sqlite`, `postgres`, `mysql`, `mariadb` — they should agree
-   Entities on disk vs. registered in `database/entities/index.ts`

Use the **cartographer** agent for this if it is available (check `.claude/agents/cartographer.md`
exists first); otherwise do it inline with `ls`, `grep` and `jq`.

Report drift; do not fix it here. Low-risk documentation drift can be corrected by
`daily-refactor` or `remediate`. Anything touching product behaviour, security or **licensing
status** stops and goes to a human — this project has published an incorrect licensing claim
three times.

## 6. Report

```
SESSION START — <date>

Repo      <branch> @ <sha>, <n> dirty, <n> ahead / <n> behind
Toolchain node <v>, pnpm <v|MISSING> -> build/test/lint <RUNNABLE|BLOCKED>
Controls  <control>: ACTIVE|INERT  (one line each)
Defects   <n> open in bug-log, <n> blocking
Drift     <one line each, or "none detected">
Next      <the single most useful next action>

STATUS: PASS | BLOCKED — <reason> | REVIEW REQUIRED — <decision needed>
```

Keep it under 25 lines. It is an orientation, not a report.
