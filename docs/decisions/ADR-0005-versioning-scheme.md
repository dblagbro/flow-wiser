# ADR-0005 — Versioning: plain SemVer on an independent Flow-Wiser line

**Status:** **Accepted**
**Date:** 2026-10-13
**Decided by:** Operator

> Supersedes the `3.1.4-fw<n>` fork-counter scheme and the rationale for it that lived in the
> `CHANGELOG.md` header.

## Context

Flow-Wiser had versioned itself as `<upstream-version>-fw<n>` — e.g. `3.1.4-fw10` — where the left
side pinned the upstream Flowise base and `fw<n>` (`fw` = Flow-Wiser) counted fork revisions. That
scheme was a deliberate choice, documented in the CHANGELOG, chosen specifically so the fork would
**not** "claim an upstream release that does not exist" by inventing a `3.2.0` or `4.0.0`.

Two things made the scheme worth revisiting:

1. **It reads as provisional, not a real release line.** `3.1.4-fw10` does not look like "a release
   of Flow-Wiser"; it looks like a patched upstream build. The project's own release identity
   should stand on its own and never borrow a deployment or instance name.
2. **Under strict SemVer, `3.1.4-fw<n>` is a _pre-release of_ `3.1.4`** and sorts _below_ it. The
   fork that removed the entire commercial identity stack sorted as "less than" plain Flowise
   3.1.4.

The original objection to `4.0.0` — that it would claim a Flowise release that does not exist — no
longer binds: **FlowiseAI's Flowise is archived (end of life, 2026-08-10) and will never publish a
`3.x` or `4.x` again.** There is no live upstream numbering left to collide with.

## Decision

Flow-Wiser uses **plain SemVer** (`MAJOR.MINOR.PATCH`, no suffix) on its **own independent release
line**, and **continues the number line forward from where Flowise stopped**: the first release
under this scheme is **`4.0.1`**, directly succeeding `3.1.4-fw10`.

-   Taking the next major (`4.x`) after Flowise's final `3.1.4` expresses that Flow-Wiser _is_ the
    continuation of the discontinued project, not a new unrelated tool.
-   The **upstream base** each release derives from is recorded as **provenance** — in the
    `CHANGELOG.md` header and per-entry, and here — **not** encoded into the version string.
-   **No instance, deployment, or operator name ever appears in the project version or in a tag the
    project itself publishes.** Deployment-specific tags are the business of the environment that
    builds them and are out of scope for the project's versioning.
-   The **package version and the Docker tag are identical** (`4.0.1`). This was already a stated
    value of the old scheme and is preserved.
-   Nothing in the codebase compares versions programmatically (the version endpoint returns a
    string; the About dialog displays it), so the sort-order concerns that constrained the old
    scheme do not apply. Do not introduce `semver.gt` release-gating that would.

Future releases are ordinary SemVer: `4.0.2` (patch), `4.1.0` (feature), `5.0.0` (breaking).

## Scope of the change

Repository only; no image is built or published by this change. Applied on this line:

-   `package.json`, `packages/server/package.json`, `packages/ui/package.json`,
    `packages/components/package.json` — `3.1.4-fw10` → `4.0.1`. (`packages/agentflow` and
    `packages/observe` keep their own independent `0.0.0-dev.<n>` publish versioning — they are
    published separately and are not part of the app's release line.)
-   `CHANGELOG.md` — header rationale retired; `[4.0.1]` entry added.
-   `README.md` + root `Dockerfile` examples — current-version strings and the `FLOWISE_VERSION`
    build-arg → `4.0.1` (the root Dockerfile asserts the build-arg matches the tree's declared
    version, so they move together).

**Historical artifacts are left as-is.** Dated release records that name old versions, and the
`[3.1.4-fw10]` and earlier CHANGELOG entries, are accurate history and are **not** rewritten.
Releases `3.1.4-fw1 … fw10` keep their names.

## Consequences

-   **Positive:** a legible release line that looks like a real project; `4.0.1 > 3.1.4` sorts
    correctly; the version is decoupled from any deployment identity.
-   **Trade-off:** the version string no longer shows the upstream base at a glance — provenance now
    requires reading the CHANGELOG/this ADR. Accepted: the base is fixed (Flowise is EOL and will not
    move), so carrying it in every version string bought little.
-   **Migration note:** consumers who pinned `3.1.4-fw10` must move to `4.0.1`. Because the old
    scheme sorted as a pre-release of `3.1.4`, tooling that resolved "latest" by SemVer will now
    correctly see `4.0.1` as newer.
