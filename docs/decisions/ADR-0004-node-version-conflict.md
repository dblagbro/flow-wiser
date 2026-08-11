# ADR-0004 — Node version: standardise on Node 22

**Status:** **Accepted**
**Date:** 2026-08-11
**Decided by:** Operator

> Originally raised as an unresolved conflict requiring a human decision (RM-02). Decided
> 2026-08-11: **Node 22**, with every artifact aligned to it.

## Context

Artifacts disagreed about which Node version this project runs on, and one of them asserted that
the declared version cannot build. A fuller survey during remediation found **five distinct values
across eleven locations** — more fragmentation than first recorded:

| Artifact                                           | Stated                                                           | Evidence            |
| -------------------------------------------------- | ---------------------------------------------------------------- | ------------------- |
| `package.json` → `engines.node`                    | `^24`                                                            | observed 2026-08-11 |
| `packages/server/package.json` → `engines.node`    | `^24`                                                            | observed 2026-08-11 |
| `.nvmrc`                                           | `v24.15.0`                                                       | observed 2026-08-11 |
| `Dockerfile` → `ARG NODE_VERSION`                  | `20`                                                             | observed 2026-08-11 |
| `docker/Dockerfile` → `ARG NODE_VERSION`           | `20`                                                             | observed 2026-08-11 |
| `docker/worker/Dockerfile`                         | **`node:24-alpine`, hardcoded, no build arg**                    | observed 2026-08-11 |
| `.github/workflows/main.yml` (CI matrix)           | `24.15.0`                                                        | observed 2026-08-11 |
| `.github/workflows/publish-package.yml` (×2)       | `20.20.2`                                                        | observed 2026-08-11 |
| `docker-image-dockerhub.yml` / `-ecr.yml` defaults | `24`                                                             | observed 2026-08-11 |
| [`PROJECT-LOG.md`](../PROJECT-LOG.md)              | **Node 24 cannot build** — `better-sqlite3` fails under node-gyp | recorded 2026-08-05 |
| Published images                                   | run Node **v20.20.2**                                            | recorded 2026-08-05 |
| Build machine                                      | Node **v22.23.2**                                                | observed 2026-08-11 |

The worker Dockerfile is the sharpest case: it pinned Node 24 **with no build arg**, so CI could
not override it the way it overrode the other two. Given the documented `better-sqlite3` failure on
Node 24, that image could not build at all — a latent breakage hidden by the fact that nobody had
built it since.

`PROJECT-LOG.md` records the finding directly: _"`ARG NODE_VERSION=24` cannot build.
`better-sqlite3` fails under node-gyp. Every published image runs Node v20.20.2, so CI was
overriding the default and the breakage went unnoticed."_

So the declared version is one nobody builds with; the version actually shipped is two majors
below it; and the machine in front of us is a third value again. Whether the `better-sqlite3`
incompatibility still holds at Node 24.15.0 has **not** been retested since 2026-08-05.

### Why this is blocking

`pnpm` is not installed here, and provisioning it via corepack is entangled with this question:
installing under the wrong Node version reproduces the documented native-module failure. Until it
is settled, `pnpm build`, `pnpm test` and `pnpm lint` cannot run, so **every verification workflow
must report BLOCKED** rather than PASS. That is RM-01.

## Decision

**Standardise on Node 22.** Every artifact that names a Node version is aligned to it:

| Artifact                                           | Now                                                                               |
| -------------------------------------------------- | --------------------------------------------------------------------------------- |
| `.nvmrc`                                           | `v22.23.2` (exact pin, for reproducibility)                                       |
| `package.json` → `engines.node`                    | `^22`                                                                             |
| `packages/server/package.json` → `engines.node`    | `^22`                                                                             |
| `Dockerfile` → `ARG NODE_VERSION`                  | `22`                                                                              |
| `docker/Dockerfile` → `ARG NODE_VERSION`           | `22`                                                                              |
| `docker/worker/Dockerfile`                         | `ARG NODE_VERSION=22` + `FROM node:${NODE_VERSION}-alpine` — **made overridable** |
| `.github/workflows/main.yml` matrix                | `22.23.2`                                                                         |
| `.github/workflows/publish-package.yml` (×2)       | `22.23.2`                                                                         |
| `docker-image-dockerhub.yml` / `-ecr.yml` defaults | `22`                                                                              |

Rationale: Node 22 is an actively supported LTS line, avoids the documented Node 24
`better-sqlite3`/node-gyp failure, and does not standardise onto Node 20, which is near end of
support and would only defer the decision. It also matches the build machine, so the toolchain is
verifiable locally rather than only in CI.

`engines.pnpm` is unchanged at `^10.26.0`.

## Consequences

-   **The toolchain is unblocked.** pnpm 10.26.0 was provisioned via corepack on Node 22, clearing
    RM-01. `build`, `test` and `lint` can run, so workflows can report PASS/FAIL on evidence instead
    of `BLOCKED`.
-   **The worker image can build again.** Its hardcoded Node 24 base is now an overridable arg on 22.
-   **Images move from Node 20 to Node 22.** This changes the shipped runtime. The first image built
    after this change must be verified end to end before release — a Node major is exactly the kind
    of change that passes CI and fails at runtime.
-   `engines.node: ^22` will now **refuse** installs on Node 20 or 24. That is intended: a loud
    failure is better than a silent success on a version nobody tests.
-   All eleven locations must stay in step. Divergence is what produced this ADR, and nothing
    currently prevents it recurring — see Follow-up.

## Verification, 2026-08-11 — and a correction to the premise

`pnpm install` was run on Node v22.23.2 with pnpm 10.26.0. **Result: success, exit 0, 8m 2.3s.**

**The `better-sqlite3` premise does not hold for this tree.** `better-sqlite3` is **not installed
and not a declared dependency**. It appears in `pnpm-lock.yaml` only inside LangChain's large
**optional peer-dependency** list (`better-sqlite3: '>=9.4.0 <12.0.0'`), and nothing pulls it in.

The SQLite driver actually used is **`sqlite3@5.1.7`**, and on Node 22 it:

-   compiled its native binding — `node_modules/.pnpm/sqlite3@5.1.7/.../build/Release/node_sqlite3.node`
-   **loads successfully at runtime** — `require('sqlite3')` returns without error

So the node-gyp failure recorded on 2026-08-05 was against a dependency this tree no longer
installs. That does **not** invalidate the decision — Node 22 is chosen on support lifecycle, and
it is now demonstrated to build and load the native driver that is actually used. But the original
framing ("Node 24 cannot build because `better-sqlite3` fails") should not be repeated as a current
fact. It is history, not present state.

**Not verified:** `pnpm build`, `pnpm test`, `pnpm lint`, and any Docker image build or boot on
Node 22. `pnpm install` succeeding is necessary, not sufficient. See RM-12.

**Note:** pnpm 10 skipped build scripts for 19 packages (`@swc/core`, `canvas`, `sharp`,
`puppeteer`, `esbuild`, `cypress`, `couchbase`, `ssh2` and others) pending `pnpm approve-builds`.
Some are needed at runtime or build time, so this must be resolved before the build and test gates
can be trusted — tracked as RM-13.

## Follow-up — required, not optional

Per [ADR-0003](ADR-0003-agentic-methodology.md), _a control nobody observes running is not a
control._ Aligning the values does not stop them drifting apart again.

1. **Add a CI job asserting Node-version parity** across `.nvmrc`, both `engines.node` fields, all
   three Dockerfile `ARG NODE_VERSION` defaults, and the workflow Node versions. Verify it on a
   known-bad input (deliberately skew one value, confirm it fails) and a known-good one.
2. **Verify a built image on Node 22** before any release — `docker build` plus a real boot,
   not just a successful compile.
3. Re-run the full test suite on Node 22 and record the result in `docs/testing.md`.

## Alternatives considered

-   **Standardise on Node 20.** Rejected: matches the shipped runtime, but Node 20 is near end of
    support, so it defers the decision rather than making it.
-   **Keep Node 24 and fix `better-sqlite3`.** Rejected: highest cost, and the documented node-gyp
    failure is a hard blocker with no owner.
-   **Let an agent align the artifacts to the majority value.** Rejected. It looks like tidying
    drift, but it silently picks a supported-platform policy — and the majority value was one a
    documented finding says cannot build. That is a product decision, and it was escalated.
-   **Ignore it and use whatever is installed.** Rejected: it is how the breakage went unnoticed the
    first time, with CI quietly overriding a default that did not work.
