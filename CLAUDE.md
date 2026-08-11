@AGENTS.md

# CLAUDE.md — Claude Code notes for Flow-Wiser

`AGENTS.md` above is the contract. This file adds only what is specific to running Claude Code
in _this_ working copy. It does not restate the contract.

## How to work here

Invoke **workflows**, not agents. Ask for the outcome and the matching skill runs:

| You want                                           | Skill                  |
| -------------------------------------------------- | ---------------------- |
| Orient at the start of a session                   | `session-start`        |
| Small, bounded cleanup                             | `daily-refactor`       |
| A large planned restructure                        | `master-refactor`      |
| A quick check of what changed                      | `daily-qa`             |
| A full release-grade QA sweep                      | `master-qa`            |
| Work through known defects                         | `remediate`            |
| Decide whether a build can ship                    | `final-release-gate`   |
| Prepare a release (prepare only — never publishes) | `publish-release`      |
| Chase a hard bug to root cause                     | `deep-debug`           |
| Dated competitive / licensing research             | `market-review`        |
| Assess container and K8s posture                   | `kubernetes-readiness` |

Skills pick their own subagents from `.claude/agents/`. You should never have to name one.

## Environment hazards specific to this checkout

**1. This tree sits inside an unrelated git repository.**
`/mnt/s` is itself a checkout of `bitbucket.org/c1c_rnd/ivrloadtester` (branch
`implement/cloudConnector`). `/mnt/s/code/flow-wiser` is a _separate, nested_ repo that the
parent sees only as an untracked directory.

-   Always run git from **inside** `/mnt/s/code/flow-wiser`, never from a parent.
-   **Never `git add -A` or `git add .` from `/mnt/s`** — it would stage this entire 208 MB tree
    into the ivrloadtester repo.
-   Never commit to, stage in, or otherwise modify the ivrloadtester repo.

**2. A real credentials file is in the working directory.**
`flowise-credentials-backup-20260805-153047.json` is a credential export from a production
Flowise database. It is root-owned `0600`, untracked, and hard-ignored by `.gitignore`.
**Do not read it, move it, copy it, print it, or commit it.** It is left in place deliberately.

**3. `/mnt/s` is an NFS4 mount.**
`node_modules`, the pnpm store and the turbo cache will be slow and lock-prone over NFS. Keep
them on local disk:

```bash
pnpm config set store-dir /home/dblagbro/.pnpm-store
export TURBO_CACHE_DIR=/home/dblagbro/.turbo-cache
```

**4. The toolchain needs `~/.local/bin` on `PATH`.**
The project runs on **Node 22** (ADR-0004). pnpm is installed via corepack into a user-local bin,
because plain `corepack enable` fails with `EACCES` symlinking into `/usr/bin` without root:

```bash
corepack enable --install-directory ~/.local/bin
export PATH=~/.local/bin:$PATH      # add to your shell profile
pnpm config set store-dir /home/dblagbro/.pnpm-store   # keep the store off NFS
```

Without that export, `pnpm` looks missing and every gate will report BLOCKED for the wrong reason.

**Node version is settled — do not change it casually.** Eleven locations carry it (`.nvmrc`, two
`engines.node` fields, three Dockerfile `ARG NODE_VERSION` defaults, and five workflow values).
They must move together; divergence is what produced ADR-0004 in the first place.

**"Node" is ambiguous in this project.** Node.js is the runtime. A _node_ is also a drag-and-drop
canvas component with its own `version: number` — see `docs/backlog.md` BL-02. Never conflate them
in code, commits, docs or UI copy.

**5. Git hooks are not active in this clone.**
`core.hooksPath` is unset and `node_modules` is absent, so neither `.githooks/pre-commit` nor
husky runs here. See `docs/remediation-plan.md` for the enable-and-verify procedure. Until it is
done, the clean-room guard exists but **does not execute locally** — CI is the only enforcement.

## Reporting

Skills end with an explicit verdict: **PASS**, **FAIL**, **BLOCKED**, or **REVIEW REQUIRED**.
Report what actually happened. If tests failed, show the output. If a step was skipped, say so.
Never report a control as working on the strength of it existing.
