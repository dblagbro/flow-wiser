---
name: final-release-gate
description: Decide whether a build can ship. Verifies every gate actually executed on the release commit, distinguishes fixed-in-tree from in-image from deployed, and returns a hard RELEASABLE or NOT RELEASABLE verdict. Read-only — it never releases.
---

# final-release-gate

A verdict, not a to-do list. **A gate is passed by going through it, not around it.** If a gate
fails, the answer is NOT RELEASABLE — never "releasable with caveats".

## 1. Orient

Read `AGENTS.md`, `docs/release-readiness.md`, `docs/bug-log.md`, `docs/ISSUE-REGISTER.md`,
`docs/qa-notes.md`, `CHANGELOG.md`.

```bash
cd /mnt/s/code/flow-wiser
git rev-parse --abbrev-ref HEAD && git rev-parse HEAD
git status --porcelain          # must be empty
jq -r '.version' package.json
git log --oneline @{u}..HEAD    # unpushed commits
```

Use the **release-engineer** agent if `.claude/agents/release-engineer.md` exists; otherwise
run inline to the same standard.

## 2. Verify each gate actually executed

The core discipline: **existence is not execution.** For every required check, confirm it ran
**on the release commit**, in the environment that actually runs it.

| Gate                 | Verify                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Clean tree           | `git status --porcelain` empty                                                                                    |
| CI green             | the run exists **on this commit**, and required checks are genuinely required                                     |
| Checks actually ran  | **`skipped` ≠ `success`.** A job gated on another repository name, or on a branch this work isn't on, did not run |
| Lint / build / tests | executed, with counts; not inferred                                                                               |
| Test discovery       | `node scripts/assert-test-discovery.js` — no suite silently unrun                                                 |
| Clean-room guard     | **observed** to run on this commit; protected paths cover `.github/workflows/**`                                  |
| Local hooks          | `core.hooksPath` set and husky installed, or explicitly noted as inert                                            |
| Blocking defects     | zero open in `docs/bug-log.md`                                                                                    |
| Security findings    | none open at critical/high; each fix has a negative test                                                          |
| Image pinning        | build-arg pinning + installed-equals-requested assertion intact                                                   |
| Version truthfulness | the artifact reports the version it claims                                                                        |
| Secrets              | no `.env`, credential export, key, QA fixture or test account in the release                                      |
| Changelog            | dated, user-visible, matches what actually changed                                                                |

## 3. The three levels — state all three

Never collapse these:

-   **FIXED IN TREE** — on the branch
-   **IN IMAGE** — present in the built artifact
-   **DEPLOYED** — live where it matters

A fix that is in the tree but not in the image has not shipped. An image that is not deployed has
closed nothing in production. This project shipped three mislabelled images and held a live
disclosure open while its documents said fixed — verify, do not assume.

## 4. Hard rules

-   Read-only. Do not push, tag remotely, publish, deploy, or merge.
-   **Never weaken, disable or reconfigure a gate to make the release pass.** That is the worst
    available outcome and it is explicitly prohibited (`AGENTS.md §11`).
-   Do not re-run CI hoping for green. A flaky required check is itself a finding.
-   Production is read-only: GET only to confirm the deployed version.

## 5. Report

```
RELEASE GATE — <date>
Candidate  <commit> / <version> / <image> / deployed: <where>

Gate                    Result    Evidence
<each gate>             PASS/FAIL/NOT RUN   <one line>

Levels     fixed-in-tree <n> · in-image <n> · deployed <n>
Blockers   <ordered, each with what specifically would clear it>
Operator   <actions only a human can take: redeploy, rotate, enable branch protection>

VERDICT: RELEASABLE | NOT RELEASABLE — <blocking reason>
STATUS:  PASS | FAIL | BLOCKED — <need> | REVIEW REQUIRED — <decision>
```

If RELEASABLE, hand over to `publish-release` — which also stops short of publishing.
