# Backup and recovery plan

**Last updated: 2026-08-11**

What is irreplaceable, where it lives, and how to restore it.

## ⚠️ Irreplaceable: three local clones hold branches that no longer exist on the remote

`wip/unbrick`, `wip/versioning-ui` and `wip/release` are **absent from `origin`**. Whether they
were merged into `apache2-only` or deleted unmerged has not been verified. Until it is, these
working copies are the only known holders of that history.

| Path                                       | HEAD branch         | Knew `origin/apache2-only` as | Last fetch |
| ------------------------------------------ | ------------------- | ----------------------------- | ---------- |
| `/home/dblagbro/work-flowwiser-agent/repo` | `wip/release`       | `55f119ce`                    | 2026-08-08 |
| `/home/dblagbro/fw-vui-work/repo`          | `wip/versioning-ui` | `9641ffdb`                    | 2026-08-06 |
| `/home/dblagbro/work-unbrick-agent/fw`     | `wip/unbrick`       | `519e25e8`                    | —          |

**Do not delete, clean, reset or garbage-collect these directories.** All three were clean
(0 dirty files) when checked on 2026-08-11.

**Priority action — verify before anything else:** for each branch, check whether its tip is an
ancestor of `origin/apache2-only`:

```bash
git -C <clone> merge-base --is-ancestor <branch> origin/apache2-only && echo "MERGED — safe" || echo "UNMERGED — irreplaceable"
```

Anything reported UNMERGED must be preserved (bundle it: `git bundle create <name>.bundle <branch>`)
before those directories are touched. **Pushing a recovered branch requires authorization.**

## Repository

|                      |                                                          |
| -------------------- | -------------------------------------------------------- |
| Authoritative remote | `github.com/dblagbro/flow-wiser`                         |
| Working copy         | `/mnt/s/code/flow-wiser` (NFS4)                          |
| Baseline branch      | `apache2-only`                                           |
| Pre-methodology tag  | `pre-methodology-20260811` → `ffae9952` (**local only**) |
| Published images     | `dblagbro/flow-wiser` on Docker Hub                      |

The remote plus the three clones give reasonable redundancy for tracked content. Nothing here
protects **untracked** content.

## Local snapshots

| Path                                             | Contents                                                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/mnt/s/code/flow-wiser-docs-snapshot-20260811/` | the docs-only tree that occupied the working directory before the repo was materialized (6 root `.md` files + 10 `docs/` files, dated 2026-08-06) |

Retain until someone confirms nothing in it was lost — its `README.md`, `CHANGELOG.md`, `FORK.md`,
`NOTICE`, `SECURITY.md` and `LICENSE.md` all **differed** from the repository versions, and the
differences have not been reviewed.

## Not backed up — and must not be

`flowise-credentials-backup-20260805-153047.json` in the working directory is **real credential
material** exported from a production Flowise database. It is root-owned `0600`, untracked, and
hard-ignored by `.gitignore`.

-   **Never** commit, copy, sync, archive or upload it.
-   **Never** read or print its contents.
-   It is excluded from every backup procedure here, deliberately.
-   Its existence is itself a risk. Rotating the exposed credentials and removing the file is an
    **operator action** — recommended, never performed by an agent.

## Production data

Not covered by this document. Production database backup, retention and restore are operator
responsibilities. Two rules bind anyone working in this repository:

-   **Production is read-only in every workflow.** GET only. No mutating request, migration, CLI
    command or restart against a live instance.
-   QA fingerprints the production database before a run and re-checks it at teardown. A changed
    fingerprint voids the run.

## Restore procedures

**Working copy from the remote** — the checkout is nested inside an unrelated repository, so
never clone over `/mnt/s` itself:

```bash
git clone https://github.com/dblagbro/flow-wiser.git /mnt/s/code/flow-wiser
cd /mnt/s/code/flow-wiser && git checkout apache2-only
```

**Restore to the pre-methodology state** (local tag, this working copy only):

```bash
git -C /mnt/s/code/flow-wiser diff pre-methodology-20260811   # review first
git -C /mnt/s/code/flow-wiser checkout pre-methodology-20260811 -- <path>
```

**Recover a branch missing from the remote** — from whichever clone holds it, verify first, then
bundle. Pushing it back requires authorization.

## Gaps

1. The merged/unmerged status of the three `wip/*` branches is **unverified**. Highest priority.
2. No automated backup of the working copy; it relies on the remote and the three clones.
3. The docs snapshot differences have not been reviewed.
4. No documented restore _test_ — a backup that has never been restored is a hypothesis. See
   `PROCESS-GAPS.md` G1: a control is not in place until observed working.
