---
description: CI workflows, hooks and container definitions — control integrity and pinning rules
globs:
    - '.github/workflows/**'
    - '.githooks/**'
    - '.husky/**'
    - 'Dockerfile'
    - 'docker/**'
    - '.dockerignore'
alwaysApply: false
---

# CI, hooks and containers

These files **are** the project's controls. Changing them changes what is enforced, so they are
treated as higher-risk than application code, not lower.

## Never, without explicit per-occasion authorization

-   Weaken, disable, skip or narrow the clean-room guard (`cleanroom-guard.yml`,
    `proprietary-path-guard.yml`, `.githooks/pre-commit`) or CODEOWNERS
-   Change publish or release jobs (`publish-*.yml`, `docker-image-*.yml`, `release-gate.yml`)
-   Relax a gate so a failing check passes. **A gate is passed by going through it, not around it** —
    this is the single worst change available in this repository
-   Remove the version-pinning assertion from any Dockerfile

The protected-path list must keep covering `.github/workflows/**` itself. Without that, a PR can
disable the guard that polices it — this was found and is still only partially mitigated (CI-02
in `docs/bug-log.md`; it needs "Require review from Code Owners" enabled on `main`).

## Existence is not enforcement

A control counts only when it has been **observed failing on a known-bad input and passing on a
known-good one, in the environment that actually runs it.** Both halves.

Ways controls here have silently not run:

-   `if: github.repository == 'FlowiseAI/Flowise'` — inherited from upstream, structurally
    incapable of running in a fork. Skipped 57 of 57 runs.
-   `on: push: branches: [main]` while all work happens on another branch.
-   `core.hooksPath` unset, so `.githooks/pre-commit` never runs in a fresh clone — which is how
    delegated agents work.
-   **`skipped` counted as `success`** in a gate's own result logic.

After changing a control, demonstrate both halves. Do not assume; `PROCESS-GAPS.md` G1.

## Container rules

-   **Pin every version, and pass it as a build arg** so it participates in the layer cache key.
    An unpinned `npm install -g flowise` never changed its command text, so the layer was reused
    forever and three published images shipped the wrong server — while `/api/v1/version` truthfully
    reported the stale value and the tag claimed otherwise.
-   **Assert installed == requested, and fail the build loudly.** Caching bugs are silent; a
    stale-but-working install looks exactly like a fresh one.
-   **Apply pins in one install and gate after all mutations.** A later `npm install` can revert an
    earlier pin while the earlier step's own assertion still prints success — `3.1.4-fw2` was built
    and discarded for exactly this.
-   `node` as PID 1, never a package manager. Non-root user. A real `HEALTHCHECK`.
-   Never write a secret into a Dockerfile, compose file, manifest or image layer.
-   `.dockerignore` must keep excluding `upstream-archive/` and all secret material.

## Shell in hooks and workflows

Never interpolate a ref, tag, branch or PR title directly into a shell command — a tag name
reaching a shell unquoted was a real finding here (CI-01). Use environment variables and quote them.
