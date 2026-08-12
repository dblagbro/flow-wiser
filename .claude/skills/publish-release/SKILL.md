---
name: publish-release
description: Prepare a release — version bump, changelog, release notes, local tag, and a verified artifact — then hand the human the exact publish commands. Prepares only; it never pushes, tags remotely, publishes to a registry, or deploys.
---

# publish-release

**This skill prepares. A human ships.** Every outward action is theirs. You assemble everything
up to that line, verify it, and hand over exact commands.

## 1. Gate first

Run `final-release-gate` and require **RELEASABLE**. If it returns NOT RELEASABLE, stop and
report. Do not prepare a release for a build that failed its gate, and never adjust a gate to
obtain a pass.

## 2. Orient

Read `AGENTS.md`, `docs/release-readiness.md`, `CHANGELOG.md`, `docs/RELEASE-NOTES-*.md` and
`docs/PUBLISH-*.md` for the established format.

```bash
cd /mnt/s/code/flow-wiser
git status --porcelain && git rev-parse --abbrev-ref HEAD && git rev-parse HEAD
jq -r '.version' package.json && git tag -l 'v3.1.4-fw*' | tail -5
```

Use the **release-engineer** agent if available; otherwise inline to the same standard.

## 3. Prepare

-   **Version** — bump to the next `3.1.4-fwN` across the manifests that carry it. Confirm nothing
    is left on the old version.
-   **Changelog** — a dated, user-visible entry. Describe what changed for users, not commit
    subjects. Security fixes get their impact stated plainly, without publishing exploit detail
    ahead of the fix being deployed.
-   **Release notes** — following the existing `docs/RELEASE-NOTES-*.md` shape.
-   **Artifact** — build the image with the version pinned as a build arg. Confirm the
    installed-equals-requested assertion is present and passes, and that the running artifact
    reports the version it claims. An image whose tag and contents disagree is the defect this
    project was founded on.
-   **Docs** — update `docs/current-state.md` and `docs/release-readiness.md`.

Local commits and a **local** tag are permitted here. Stage files by name — never `git add -A`,
never `git add .`, and never run git from a parent directory (this tree is nested inside an
unrelated repository).

## 4. Final safety sweep

-   No `.env`, `*.sqlite`, `*.pem`, `*.key`, credential export, QA fixture or test account included
-   No secret in any layer, manifest, changelog or commit message
-   `.dockerignore` excludes `upstream-archive/` and all secret material
-   No licensing claim added anywhere without evidence and human sign-off — **do not add one**
-   `packages/server/src/enterprise/**` and `IdentityManager.ts` untouched

## 5. Absolutely prohibited

`git push` (including `--tags`, including `--force`) · publishing to npm, Docker Hub, ECR or any
registry · deploying · restarting production · creating or merging a PR · rotating live
credentials · deleting or rewriting branches, tags or history.

If a workflow would publish automatically on a pushed tag, **say so explicitly in the handover** —
the human needs to know that pushing the tag _is_ the publish.

## 6. Hand over

```
RELEASE PREPARED — <date>
Version    <old> -> <new>
Commit     <sha>   Local tag: <tag> (NOT pushed)
Artifact   <image:tag> — version assertion PASS, reports <version>
Changed    <files>
Gate       RELEASABLE (per final-release-gate, <date>)

TO PUBLISH — requires your authorization, run these yourself:
  git push origin <branch>
  git push origin <tag>          # NOTE: this triggers <workflow> and publishes
  docker push <image:tag>
  <deploy command>

STATUS: PASS — prepared, awaiting your authorization
        | BLOCKED — <need> | REVIEW REQUIRED — <decision>
```

End there. Do not run the commands.
