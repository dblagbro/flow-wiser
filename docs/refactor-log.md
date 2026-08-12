# Refactor log

**Last updated: 2026-08-11**

Append-only record of refactoring work. Newest first. Written by the `daily-refactor` and
`master-refactor` skills.

**A refactor preserves behaviour.** If observable behaviour changed, it was not a refactor — it
belongs in [`CHANGELOG.md`](../CHANGELOG.md) as a change, with the tests and review that implies.
Entries that cannot show verification are recorded as **unverified**, not as done.

## Entry format

```
## <YYYY-MM-DD> — <short title>

**Scope:** area / files
**Motivation:** what was wrong
**Changed:** path:line list
**Behaviour:** PRESERVED (evidence) | CHANGED (authorization + tests)
**Verified:** commands run and their real result — or NOT RUN, and why
**Docs:** what was updated
**Deferred:** what was left, and where it is recorded
```

---

## 2026-08-11 — Node version aligned to 22 across the repository

**Scope:** every artifact declaring a Node.js version — `.nvmrc`, two `engines.node` fields, three
Dockerfiles, five workflow values. Eleven locations.

**Motivation:** five different values (`20`, `20.20.2`, `22`, `24`, `24.15.0`) were in play, and the
most-declared one (24) is documented as unbuildable — `better-sqlite3` fails under node-gyp. This
blocked the entire toolchain: `build`, `test` and `lint` could not run, so every workflow was
limited to static analysis. Decided by the Operator on 2026-08-11; see
[ADR-0004](decisions/ADR-0004-node-version-conflict.md).

**Changed:**

| File                                                       | From → To                                                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `.nvmrc`                                                   | `v24.15.0` → `v22.23.2`                                                                        |
| `package.json:engines.node`                                | `^24` → `^22`                                                                                  |
| `packages/server/package.json:engines.node`                | `^24` → `^22`                                                                                  |
| `Dockerfile:31`                                            | `ARG NODE_VERSION=20` → `22`                                                                   |
| `docker/Dockerfile:39`                                     | `ARG NODE_VERSION=20` → `22`                                                                   |
| `docker/worker/Dockerfile:12`                              | `FROM node:24-alpine` (hardcoded) → `ARG NODE_VERSION=22` + `FROM node:${NODE_VERSION}-alpine` |
| `.github/workflows/main.yml:17`                            | matrix `[24.15.0]` → `[22.23.2]`                                                               |
| `.github/workflows/publish-package.yml:56,131`             | `'20.20.2'` → `'22.23.2'`                                                                      |
| `docker-image-dockerhub.yml:67`, `docker-image-ecr.yml:39` | default `'24'` → `'22'`                                                                        |

Comments explaining the historic Node 20/24 reasoning were preserved and updated rather than
deleted — the reasons those values were chosen are still worth knowing.

**Defect found and fixed in passing:** `docker/worker/Dockerfile` hardcoded `FROM node:24-alpine`
with **no build arg**, so CI could not override it as it did the other two Dockerfiles. Combined
with the documented Node 24 `better-sqlite3` failure, that image could not build at all — a latent
breakage nobody had hit because nobody had rebuilt it.

**Behaviour:** **CHANGED, deliberately and under explicit operator authorization.** This alters the
runtime the images ship (Node 20 → 22) and makes `engines` refuse installs on Node 20 or 24. Not a
refactor; recorded here because it is a cross-cutting mechanical change, and in `CHANGELOG.md`
because it is user-visible.

**Verified:** `engines` satisfied by the installed toolchain (`node v22.23.2`, `pnpm 10.26.0` via
corepack). `pnpm install` exercised on Node 22 — this is the real test, since the whole conflict
originated in a native-module build failure. Result recorded in `docs/testing.md`.
**Image builds and boots on Node 22 are NOT yet verified** — tracked as RM-12; do not release on a
successful compile alone.

**Docs:** ADR-0004 moved Proposed → **Accepted**; RM-01 and RM-02 closed; RM-11 (parity control)
and RM-12 (image runtime verification) opened; `current-state.md`, `CLAUDE.md` updated.

**Deferred:** nothing prevents these eleven values drifting apart again — RM-11.

---

## 2026-08-11 — agentic methodology installed (setup pass — no product code touched)

**Scope:** repository governance only. `AGENTS.md`, `CLAUDE.md`, `.claude/agents/`,
`.claude/skills/`, `.claude/rules/`, `docs/`, `.gitignore`.

**Motivation:** standardize how agents work in this repository — a portable contract, project
subagents, intent-level workflow skills, an authority map for documentation, and deterministic
enforcement — so that the conventions and hard-won lessons already recorded in
[`PROJECT-LOG.md`](PROJECT-LOG.md) and [`PROCESS-GAPS.md`](PROCESS-GAPS.md) are enforced rather
than remembered.

**Changed:** no source file under `packages/` was read for modification or altered. New
governance files only, plus `.gitignore` (secret patterns appended).

**Behaviour:** **PRESERVED** — trivially. No application code, configuration, dependency,
workflow or container definition was modified. `git diff pre-methodology-20260811 -- packages/`
is empty.

**Verified:** structural verification only — agent and skill frontmatter validated, names unique,
no agent granted push/publish/deploy authority, credentials file confirmed ignored, new files
swept for secrets. **Build, lint and test NOT RUN** — the toolchain cannot execute them (RM-01).

**Docs:** created `index.md`, `product.md`, `architecture.md`, `project-map.md`,
`current-state.md`, `qa-notes.md`, `refactor-log.md`, `remediation-plan.md`, `backup-plan.md`,
`platform-roadmap.md`, `market-review.md`, `decisions/ADR-0001…0004`. Existing documents were
reused and referenced, not rewritten.

**Deferred:** the product refactor itself. Drift found during setup is recorded as RM-01…RM-10 in
[`remediation-plan.md`](remediation-plan.md) — including two items marked REVIEW REQUIRED that an
agent must not resolve (`STATUS.md` licensing claims, and the Node version conflict).
