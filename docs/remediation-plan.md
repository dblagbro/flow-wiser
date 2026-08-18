# Remediation plan

**Last updated: 2026-08-11**

Open remediation work. Defects live in [`bug-log.md`](bug-log.md) and
[`ISSUE-REGISTER.md`](ISSUE-REGISTER.md); process failures and their controls live in
[`PROCESS-GAPS.md`](PROCESS-GAPS.md). This document tracks **what is still to be done**, ordered.

Worked by the `remediate` skill. Items marked REVIEW REQUIRED need a human decision and must not
be actioned by an agent.

## Priority 1 — blocks all verification

### RM-01 · Toolchain could not run build, test or lint

**Status:** ✅ **CLOSED 2026-08-11** — pnpm provisioned, `engines` satisfied

`engines` required Node `^24` and pnpm `^10.26.0`; the machine had Node v22.23.2 and no pnpm.
Resolved by RM-02 (standardising on Node 22) plus provisioning pnpm.

**Done:**

```bash
mkdir -p ~/.local/bin
corepack enable --install-directory ~/.local/bin     # plain `corepack enable` needs root
export PATH=~/.local/bin:$PATH
pnpm config set store-dir /home/dblagbro/.pnpm-store  # keep the store off NFS
```

`node -v` → `v22.23.2`, `pnpm -v` → `10.26.0`, both satisfying `engines`.

**Note for anyone reproducing this:** `~/.local/bin` must be on `PATH`. `corepack enable` without
`--install-directory` fails with `EACCES` symlinking into `/usr/bin` unless run as root. Add the
export to your shell profile, or the toolchain will appear missing again in a new shell.

**Store location matters here:** `/mnt/s` is NFS4. Leaving the pnpm store on it makes installs slow
and lock-prone — see `CLAUDE.md`.

### RM-02 · Node version was contested across eleven locations

**Status:** ✅ **CLOSED 2026-08-11** — Operator decided **Node 22**

Five distinct values (`20`, `20.20.2`, `22`, `24`, `24.15.0`) across eleven locations, one of which
(`docker/worker/Dockerfile`) hardcoded Node 24 with **no build arg** and therefore could not build
at all, given the documented `better-sqlite3`/node-gyp failure.

All eleven aligned to Node 22 — `.nvmrc` (`v22.23.2`), both `engines.node` fields (`^22`), three
Dockerfile `ARG NODE_VERSION` defaults, the CI matrix, `publish-package.yml` (×2), and the two
image-build workflow defaults. The worker Dockerfile was made overridable.

See [`decisions/ADR-0004-node-version-conflict.md`](decisions/ADR-0004-node-version-conflict.md)
(Accepted).

**Follow-up still open — see RM-11.**

### RM-11 · Nothing prevents the Node version drifting apart again

**Status:** OPEN · **Opened:** 2026-08-11

RM-02 aligned eleven locations by hand. Nothing stops them diverging again — and divergence is
precisely what produced ADR-0004. Per ADR-0003, aligning values is not a control.

**Action:** add a CI job asserting Node-version parity across `.nvmrc`, both `engines.node` fields,
the three Dockerfile `ARG NODE_VERSION` defaults, and the workflow Node versions. **Verify both
halves**: deliberately skew one value and confirm the job fails; restore it and confirm it passes.

### RM-12 · Images move from Node 20 to Node 22 — needs runtime verification

**Status:** OPEN · **Opened:** 2026-08-11

Published images ran Node v20.20.2. They will now be built on 22. A Node major bump is exactly the
change that compiles cleanly and fails at runtime.

**Action:** before any release, `docker build` each of the three Dockerfiles on Node 22 and **boot**
the resulting image — not just compile it. Confirm `/api/v1/ping` responds and migrations run.
Record in `docs/testing.md`. Do not publish an image on the strength of a successful build alone.

## Priority 2 — controls that exist but do not run

### RM-03 · Local clean-room hook was inert in this clone

**Status:** ✅ **CLOSED 2026-08-11** (partial — husky still inert, see below)

`core.hooksPath` was unset, so `.githooks/pre-commit` — the clean-room guard — did not run. This
was the exact condition described in `PROCESS-GAPS.md` G1: _"the pre-commit hook never runs in a
fresh clone — which is how every delegated agent worked."_

**Done:** `git config core.hooksPath .githooks`, then verified **both halves** in the environment
that runs it:

| Half                     | Input                                                        | Result                                     |
| ------------------------ | ------------------------------------------------------------ | ------------------------------------------ |
| Known-bad                | staged an added file under `packages/server/src/enterprise/` | **REJECTED**, exit 1, violation message ✅ |
| Known-good               | staged `AGENTS.md`, `docs/index.md`, `.gitignore`            | **ALLOWED**, exit 0 ✅                     |
| Deletion still permitted | `--diff-filter=ACMR` excludes `D`                            | confirmed by inspection ✅                 |

The scratch file and directory were removed and nothing was committed. The guard is now **ACTIVE**
for the first time in this clone.

**The shadowing risk flagged here was real, and it fired the same day.** `pnpm install`'s
`postinstall` runs `husky install`, which **reset `core.hooksPath` from `.githooks` to `.husky`** —
silently disabling the clean-room guard minutes after it had been enabled and verified. Nothing
warned; the guard simply stopped running.

**Durable fix applied 2026-08-11:** `.husky/pre-commit` now invokes `.githooks/pre-commit` first
and unconditionally, so the guard runs whichever `hooksPath` is in effect and survives every
reinstall. Re-verified through the husky path: known-bad rejected (exit 1), known-good allowed
(exit 0).

This is a textbook G1 recurrence — a verified control silently deactivated by an unrelated routine
command. It is why RM-11 (an automated parity/liveness check) matters more than the one-time fix.

### RM-04 · `Proprietary Path Guard` has never run and cannot run — CONFIRMED

**Status:** OPEN · **Confirmed 2026-08-11** · **Was: "unverified". Now: verified as broken.**

Observed directly by pushing `ops/methodology-and-node-22` and reading the run list:

| Workflow                 | Result         | Duration                  |
| ------------------------ | -------------- | ------------------------- |
| `Clean-room guard`       | ✅ **success** | 17s — genuinely executing |
| `Proprietary Path Guard` | ❌ **skipped** | 1s                        |

**Skipped on every run in the visible history** — this branch push, the `main` push 21h earlier,
and the `apache2-only` pull request. Never once executed.

**Cause, still present at `proprietary-path-guard.yml:34`:**

```yaml
if: github.repository == 'FlowiseAI/Flowise'
```

This is the **identical line** `PROCESS-GAPS.md` G1 identified as the cause of 57/57 skips. G1's
corrective action rewrote `cleanroom-guard.yml` — which now correctly runs on `branches: ['**']`
and passes — but **`proprietary-path-guard.yml` was never fixed.** It is upstream's own workflow,
inherited by the fork, and structurally incapable of ever running here: the condition can never be
true in `dblagbro/flow-wiser`.

G1's own lesson applies to G1's own remediation: fixing one control and assuming its sibling was
covered is how the condition survived. The guard has sat in the workflow list looking like
enforcement for the entire life of the fork.

**Mitigating:** `cleanroom-guard.yml` does run and does check the tree, so the clean-room property
is not unguarded in CI. The local `.githooks/pre-commit` chain also runs now (RM-03). The exposure
is that a workflow named as a control contributes nothing.

**Action — requires authorization (`AGENTS.md §11` — changing a CI guard):**

1. Either delete `proprietary-path-guard.yml` as dead inherited weight, or change the condition to
   `github.repository == 'dblagbro/flow-wiser'` (or drop the `if:` entirely).
2. **Verify both halves before trusting it:** push a branch containing a deliberate violation and
   confirm the run **fails**; push a clean branch and confirm it **passes**. A guard observed only
   passing has not been tested.
3. Audit every remaining workflow for the same inherited-condition pattern.
4. Confirm `skipped` is not counted as `success` anywhere a gate aggregates results (CI-01/CI-02 in
   `bug-log.md` touch this).

### RM-05 · `.husky/pre-push` protects nothing here

**Status:** OPEN · **Opened:** 2026-08-11 · **Low risk, needs confirmation**

It triggers only when the push URL matches `FlowiseAI/Flowise`, and blocks `extensions/` and
`apps/` — neither of which exists in this repository. Inherited upstream cruft. It gives a false
impression that pushes are guarded.

**Action:** replace with a guard meaningful here (licensed paths, secret patterns) or remove it.
Touches push behaviour, so **confirm with a human** before changing.

### RM-13 · pnpm's skipped build scripts — deliberate policy, not a gap

**Status:** ✅ **CLOSED 2026-08-11 as NOT A DEFECT** (opened and corrected the same day)

pnpm 10 does not run dependency build scripts unless allowlisted, and the 2026-08-11 install
reported 19 skipped packages (`@swc/core`, `esbuild` ×2, `sharp` ×2, `canvas`, `puppeteer`,
`cypress`, `couchbase`, `ssh2`, `grpc-tools`, `core-js` ×2, `bufferutil`, `utf-8-validate`,
`cpu-features`, `msgpackr-extract`, `es5-ext`, `unrs-resolver`).

This was **initially logged as a blocker. That was wrong.** `package.json` already carries a
deliberate, minimal allowlist:

```json
"pnpm": { "onlyBuiltDependencies": ["faiss-node", "sqlite3"] }
```

The skipping is the policy working as designed. Only the two packages that genuinely need to
compile native bindings are permitted to run install scripts; everything else is denied. That is a
sound security posture — approving a build script means executing that package's arbitrary code at
install time — and `sqlite3` compiled and loads precisely because it is on the list.

**Correction recorded rather than quietly deleted:** the original entry inferred a defect from a
warning message without first checking whether the behaviour was configured. The warning is
advisory; pnpm prints it regardless of whether an allowlist exists.

**Standing guidance:** do **not** run `pnpm approve-builds` to silence the warning. If a build or
test genuinely fails for want of a build script, add that single package to
`onlyBuiltDependencies` with a comment explaining why, and commit it so CI and every contributor
get the same set. Widening the allowlist is a security decision, not a convenience one.

### RM-14 · The built CLI does not start within 5 minutes from the NFS working copy

**Status:** OPEN · **Opened:** 2026-08-11 · **Environmental, not a code defect (probable)**

After a successful `pnpm build`, running the built server CLI from `/mnt/s/code/flow-wiser`:

```
$ time timeout 300 node ./bin/run --version
Terminated
real 5m2.244s   user 0m0.677s   sys 0m24.222s
```

Killed at the 300s cap without producing output.

**The CPU profile says this is I/O, not compute.** 0.68s user against 5 minutes wall clock is a
process blocked on filesystem reads, not one spinning. `/mnt/s` is NFS4, and oclif resolves its
command tree by walking a very large `node_modules` at startup — thousands of round-trips that are
sub-millisecond locally and are not over NFS.

**Not yet proven**, and it must not be assumed: it could still be a genuine startup regression that
NFS is merely amplifying. `docker/Dockerfile` has `RUN cd / && flowise --version` as a build gate,
so this same invocation is expected to pass inside a container.

**Action — cheap and decisive, run all three:**

1. Copy or clone the tree to local disk (`/home/dblagbro/…`), rebuild, and time the same command.
2. Run it inside a built container, where the tree is on the image's own filesystem.
3. If both are fast, this is confirmed environmental — document it in `CLAUDE.md` and close.
   If either is slow, it is a real startup regression and becomes a defect.

**Consequence until resolved:** any workflow needing to _run_ the server or CLI from this working
copy — smoke tests, `doctor`, `admin:create`, migration commands — should expect to time out.
Build and unit tests are unaffected; they do not start the CLI. Related: RM-12 (image boot
verification) covers the container half of this.

### RM-15 · Test suite times out under parallel workers on the NFS working copy

**Status:** OPEN · **Opened:** 2026-08-11 · **Environmental — the test itself is sound**

`pnpm test` on Node 22 (2026-08-11) returned **334 passed / 1 failed** in `@flowiseai/observe`:

```
● CodeFenceBlock › copy › does NOT flash "Copied!" when the clipboard write rejects
  thrown: "Exceeded timeout of 5000 ms for a test."
Test Suites: 1 failed, 24 passed, 25 total
Time:        2242.26 s
```

**The test is not defective.** Re-run in isolation with `--runInBand`, that same test passes in
**26 ms**, and its suite passes 8/8 in 12.6 s.

**Diagnosis: worker contention on NFS, not logic.** The full run took **37m48s**, with
`ExecutionDetail.test.tsx` alone reporting **2202 s** for tests whose individual timings are
45–1667 ms. Jest's parallel workers reading a large `node_modules` over NFS4 starve one another, and
a 5-second default timeout is then trivially exceeded regardless of what a test does. Same root
condition as RM-14.

_A discarded hypothesis, recorded so nobody re-investigates it:_ the describe block installs
`jest.useFakeTimers()` in `beforeEach`, and the failing test `await`s a **rejected** promise inside
`act()` — textbook fake-timer deadlock shape. **Wrong.** A deadlock does not resolve given more
time, and this passed in 26 ms.

**Do NOT "fix" this by raising the global jest timeout.** That masks the condition, makes genuine
timeouts invisible, and is exactly the "relax the gate until it passes" move `AGENTS.md §11`
prohibits.

**Action:**

1. Run the suite with the tree on local disk, or inside a container, and confirm it is green and
   fast. That is the real fix.
2. If tests must run from this NFS working copy, use `--runInBand` and treat wall-clock as
   unrepresentative — a green `--runInBand` run is not equivalent to CI.
3. Confirm CI (`main.yml`, on runner-local disk) is green on Node 22. **That is the authoritative
   signal, not this machine.**

### RM-16 · ESLint and Prettier read secret material — no ignore rules existed

**Status:** ✅ **FIXED 2026-08-11** · **Severity: HIGH (latent secret exposure)**

`pnpm lint` runs `eslint "**/*.{js,jsx,ts,tsx,json,md}"`. That glob matched the credential export
in the working directory, and **ESLint opened it**:

```
Error: EACCES: permission denied, open '.../flowise-credentials-backup-20260805-153047.json'
ELIFECYCLE Command failed with exit code 2
```

**Two distinct problems, one cause.**

1. **Secret exposure (the serious one).** ESLint attempted to _read_ a production credential export.
   The only thing that stopped it was the file's root-owned `0600` mode. Had the file been owned by
   the running user — the normal case for a downloaded backup — ESLint would have parsed it, and a
   parse error on a JSON file **echoes the offending content**. That output goes to a terminal, a
   log, or CI. `.gitignore` does not apply to linters; nothing else did either.
2. **The lint gate was broken outright**, exiting 2 before linting anything.

**This is the second time file permissions rather than a control protected this file.** The first
was `git add .` attempting to stage it (fixed by `.gitignore`, RM-06 era). Two independent tools
reached for the same secret; both were stopped by luck. That pattern is the finding.

**Fixed:**

-   `.eslintrc.js` → `ignorePatterns` extended with the secret patterns
-   `.prettierignore` → same patterns (Prettier is invoked by `pnpm format` **and** by `pnpm quick`
    in the husky pre-commit hook; a formatter that _rewrites_ a credential file corrupts it silently)

**Verified both halves:**

| Input                                          | Result                                                 |
| ---------------------------------------------- | ------------------------------------------------------ |
| `npx eslint flowise-credentials-backup-*.json` | `File ignored because of a matching ignore pattern` ✅ |
| `npx eslint packages/server/src/index.ts`      | lints clean, exit 0 ✅                                 |

**Three ignore lists must now stay in step** — `.gitignore`, `.eslintrc.js` `ignorePatterns`, and
`.prettierignore`. Nothing enforces that. **Fold this into RM-11's parity check**, which is already
scoped to catch exactly this class of silent divergence.

**Standing lesson:** `.gitignore` protects git and nothing else. Every tool that globs the working
tree — linters, formatters, bundlers, test runners, doc generators, secret scanners — needs its own
exclusion, and each is a separate opportunity to read a secret.

### RM-17 · `pnpm dedupe` breaks the build — do not run it

**Status:** ⛔ **CLOSED 2026-08-11 as WON'T DO** · **Standing caution, not open work**

`pnpm dedupe` on `main` @ `24ac3f92` **breaks `flowise-components`**. Do not run it, and do not
accept a PR that does, however attractive the lockfile reduction looks.

**What it promises.** 611 lockfile entries removed, 133 added (net −478); `pnpm-lock.yaml`
47,202 → 41,542 lines (**−12%**); `nanoid` consolidated from `3.3.17` + `3.3.18` to a single
`3.3.18`; no security pin touched (`vm2@3.11.5`, `multer@2.2.0`, `basic-ftp@5.2.1`, `tar-fs@3.1.1`
all intact). `pnpm install --frozen-lockfile` still passes afterwards.

**What it costs.** `pnpm build` fails at `flowise-components` with four `TS2550` errors:

```text
nodes/agents/ConversationalAgent/ConversationalAgent.ts(240,39): error TS2550:
  Property 'at' does not exist on type '(BaseMessage<...> | BaseMessagePromptTemplate<...>)[]'.
  Try changing the 'lib' compiler option to 'es2022' or later.
```

…plus the same in `ConversationalRetrievalToolAgent`, `ToolAgent` and `LLMChain`.

**Controlled test — the lockfile is the only variable.** Same worktree, same Node v22.23.2, same
pnpm 10.26.0, `packages/components` build:

| Lockfile                   | Result       |
| -------------------------- | ------------ |
| merged `main` (`24ac3f92`) | ✅ exit 0    |
| after `pnpm dedupe`        | ❌ TS2550 ×4 |

Restoring the pre-dedupe lockfile restores the build. Toggled both ways.

**Two hypotheses tested and discarded, recorded so they are not re-investigated:**

-   _"dedupe consolidated LangChain to incompatible types."_ **No** — `@langchain/core@1.1.20` and
    `langchain@0.3.6`/`1.2.18` are identical before and after.
-   _"Node 22 cannot build `flowise-components`."_ **No** — it builds fine on Node 22 with the
    pre-dedupe lockfile. This exonerates ADR-0004.

**Probable mechanism, unconfirmed.** pnpm keys packages with their peer resolutions
(`@langchain/core@1.1.20(openai@x)`). Dedupe collapses variants of the same version that carry
_different resolved types_, so `packages/components` ends up type-checking against a different
instance. `tsconfig` sets `lib: ["ES2020","ES2021.String"]`, under which `Array.prototype.at`
does not exist — one variant evidently supplied a definition that satisfied it and the survivor
does not. Confirming this is not required to act on the finding.

**If the `nanoid` duplication is worth removing**, do it narrowly: a `pnpm.overrides` entry
pinning `nanoid` to `3.3.18`. That is the project's established pattern (see `PROJECT-LOG.md` on
the `@anupamme` CVE adoptions), touches one package instead of 478, and can be verified in
isolation. Do not reach for `dedupe` to achieve it.

**Wider lesson.** `--frozen-lockfile` passing does **not** mean a lockfile change is safe. It
proves the lockfile agrees with the manifests; it says nothing about whether the resolved tree
still type-checks. Any lockfile-wide operation needs `pnpm build` **and** `pnpm test` before it is
proposed, not just an install.

### RM-19 · `faiss-node`'s CMake build is flaky in CI — every gate is unreliable at some rate

**Status:** OPEN · **Opened:** 2026-08-12 · **Demonstrated, not suspected**

`pnpm install` failed in CI while compiling `faiss-node`:

```text
node_modules/faiss-node install: CMake Error at
  /usr/local/share/cmake-3.31/Modules/FindPackageHandleStandardArgs.cmake:233 (message):
-- Configuring incomplete, errors occurred!
##[error]Process completed with exit code 1
```

**Proven flaky by the change set, not by re-rolling.** On `ops/methodology-and-node-22`:

| Commit            | What changed                        | Result                    |
| ----------------- | ----------------------------------- | ------------------------- |
| `3ad65d6e`        | code                                | ✅ success                |
| `0efadea6`        | docs                                | ✅ success                |
| `312d21cb`        | **`docs/remediation-plan.md` only** | ❌ failure (1m34s)        |
| `312d21cb` re-run | **nothing**                         | ✅ success (all 16 steps) |

A Markdown file cannot break a native CMake compile, and the re-run passed the identical commit.
`faiss-node@0.5.1` is the same on `main` and this branch, and `main`'s Node 22 probe
(run `31617333079`) installed it successfully **14 minutes before** this failure.

**Why it matters more than one red run.** `faiss-node` is one of only two entries in
`pnpm.onlyBuiltDependencies` (with `sqlite3`), so it is one of the few packages that actually
compiles during install — and it sits in `pnpm install`, the **first** step of every CI job. A
non-deterministic failure there means:

1. Every gate in this repository — lint, build, tests, discovery, Cypress — is unreliable at some
   rate, because none of them run if install fails.
2. **A real failure can be waved away as "just faiss again".** That is the expensive part. A
   normalised flake trains everyone, human and agent, to re-run instead of read. `PROCESS-GAPS.md`
   G1 is about controls that do not run; this is a control whose _result_ cannot be trusted, which
   corrodes the same way.

**The failure was fast** (1m34s vs the usual ~7m), which is a useful signature: install-stage
failures die early, so a short red run is more likely environmental than a genuine defect.

**Action:**

1. Capture the full CMake output from a failing run — the two lines above are the summary, not the
   cause. `FindPackageHandleStandardArgs` failing usually means a missing system package
   (BLAS/LAPACK/OpenMP) or a CMake version incompatibility.
2. Pin the environment rather than retry it: install the required system dependencies explicitly in
   the workflow, and/or pin CMake, so the build stops depending on whatever the runner image ships.
   Note the runner now carries **CMake 3.31**.
3. If `faiss-node` is not actually needed for CI, drop it from `onlyBuiltDependencies` for CI runs —
   nothing in the test suite obviously requires a compiled FAISS.
4. Until fixed, **do not treat a red `pnpm install` as automatically flaky.** Read the failing step
   first; only the `faiss-node` CMake signature is known-flaky.

**Do not "fix" this by adding a blanket retry to the workflow.** That converts a visible flake into
an invisible one and is the same class of error as relaxing a gate to make it pass
(`AGENTS.md §11`).

### RM-18 · `main` on Node 22 — verified green in CI; an invalid local result retracted

**Status:** ✅ **CLOSED 2026-08-12** — proven in CI. The retraction below is kept deliberately.

**The gap, as it stood.** Node 22 was verified in CI only for the `apache2-only` line (PR #15).
`main`'s matrix was `24.15.0`, so no clean environment had ever built `main`'s tree on Node 22.

**Resolved by direct measurement.** A throwaway branch was cut from `origin/main` @ `24ac3f92`
with **one line changed** — `node-version: [24.15.0]` → `[22.23.2]` — and dispatched via
`workflow_dispatch`, making the Node version the single variable. Same tree, same lockfile, clean
runner on local disk.

> **Run:** <https://github.com/dblagbro/flow-wiser/actions/runs/31617333079> · sha `6ae67f32` ·
> 2026-08-12 · **conclusion: success**
>
> Job `build (ubuntu-latest, 22.23.2)` — **all 16 steps green**, including `pnpm install`,
> `pnpm lint`, `pnpm build`, `Assert no test file is silently undiscovered`, `pnpm test:coverage`
> and `Cypress test`.
>
> The branch was deleted after the run. Actions run records persist, so the evidence stands.

**Conclusions:**

1. `main`'s tree builds, lints, unit-tests and passes e2e on Node 22. ADR-0004 now has clean CI
   evidence on **both** lines — `apache2-only` (PR #15) and `main` (this run).
2. **`@types/node@26.2.0` is exonerated.** It entered `main` at `69b281db` (the nanoid merge) and
   is absent from `afd88ac6` and from `apache2-only`. It was present in this green run, so it does
   not break the build. The concern was reasonable — the dependabot review had checked the ~141
   duplicate versions for _new packages_ and for security pins, but not for changed type
   resolution — and it is now closed by evidence rather than assumption.
3. The run covered two gates never reached locally: test discovery and Cypress e2e.

---

**The retraction — kept on purpose.** An earlier claim in this session — _"`main`'s server package
fails to build on Node 22"_ — was **wrong**, and the run above proves it: the identical tree,
lockfile and Node version pass cleanly in an uncontaminated environment. The `flowise#build`
LangGraph errors were artifacts of a broken local setup, not defects.

The local result was not merely noisy, it was **inverted** — it reported a blocking failure where
none exists. Had it been acted on, it would have stalled PR #15 over nothing.

Three methodology errors, recorded so the same evidence is not trusted later:

| Error                                                                                                                            | What it produced                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ran a foreground `pnpm --filter flowise build` **while** a background `pnpm build && pnpm test` was running on the same worktree | `flowise#build` failure and ~10 test failures. Exposed by impossible timings — suites reporting **13,586 s** and **18,023 s** in a run lasting minutes. Two `tsc` processes reading each other's half-written `dist/`                                                    |
| `pnpm --filter <pkg> build` instead of `pnpm build`                                                                              | `TS2307 Cannot find module 'flowise-components'`. `--filter` runs that package's own `tsc` and **does not build its dependencies**; turbo's `dependsOn: ["^build"]` is what orders them                                                                                  |
| Assumed `TURBO_CACHE_DIR` isolated the cache                                                                                     | turbo 1.10 **ignores** it and caches in `node_modules/.cache/turbo`. Reported `3 cached, 5 total` on a freshly wiped checkout, reusing artifacts across three different commits. Each rerun failed in a _different_ package — the signature of stale cache, not a defect |

**Rules taken from this, applicable to any future verification here:**

1. **One build at a time per worktree.** Never run a second build or test against a tree that
   already has one in flight.
2. **Always `pnpm build`**, never `pnpm --filter … build`, when the result is meant to prove
   anything — only the full run respects build order.
3. **Trust nothing after a cache-affecting change** unless `node_modules/.cache/turbo` was removed;
   setting `TURBO_CACHE_DIR` does not do it.
4. **One commit per worktree.** Checking out several commits into one worktree, with installs and
   `dist/` wipes between, produces results attributable to nothing.
5. **CI is the authoritative signal.** A local run on this NFS-mounted, multi-checkout machine is
   a hint. When local and CI disagree, CI wins — and when a local result would change a decision,
   reproduce it in CI before acting.

**The cheap instrument that settled it, for reuse.** Cut a branch from the ref under test, change
**one** value, push, and `gh workflow run <workflow> --ref <branch>`. `workflow_dispatch` avoids
opening a PR, so there is nothing to merge by accident; delete the branch afterwards and the run
record persists as evidence. It took minutes and produced an answer no amount of local iteration
could — because the local environment was the thing at fault.

The `pnpm dedupe` finding (RM-17) is **unaffected**: it was isolated, single-variable, toggled both
ways, and completed before any of the above.

### RM-06 · WITHDRAWN — the drift it reported never existed

**Status:** ❌ **WITHDRAWN 2026-08-12.** Raised in error. No action needed, and none was ever needed.

**What it claimed.** That `docs/STATUS.md` states the auth/RBAC replacement is "not started",
entities "not registered", "no route file points at the new RBAC", and the licensed files "not
deleted" — all contradicted by the tree, and therefore REVIEW REQUIRED because the file carries
licensing claims.

**What is actually true.** `docs/STATUS.md` is dated **2026-08-09** and says the opposite:

| Row                                                 | Says                                                 |
| --------------------------------------------------- | ---------------------------------------------------- |
| `3.1.4-fw8` — Apache-2.0-only                       | ✅ Released                                          |
| The 127 commercially licensed files                 | ✅ Deleted, and the build fails if any trace returns |
| RBAC — 82 permissions, server-side, deny-by-default | ✅ Shipped                                           |
| MFA, SSO, audit trail, encryption at rest           | ✅ Shipped                                           |

None of the quoted phrases appear in it.

**Where the quotes came from.** A **stale docs-only copy dated 2026-08-05** that occupied
`/mnt/s/code/flow-wiser` before the repository was materialized there. That directory held six
Markdown files and a `docs/` folder and **no source code at all**. It was read during discovery,
the repository was then checked out over it, and the earlier reading was carried forward as though
it described the tree.

**Why it is recorded rather than deleted.** The failure is worth more than the entry:

-   An artifact was read **before** the thing it describes existed, and the reading was never
    re-taken afterwards. Every later observation was compared against a document from a different
    directory and a different week.
-   It produced a **false blocker on the most sensitive topic in the project** — licensing — and
    invoked "an incorrect licensing claim was published three times" to justify escalating it. A
    fabricated REVIEW REQUIRED on licensing costs real human attention and erodes the credibility
    of genuine ones.
-   It was repeated across `current-state.md`, `index.md` and several session reports before anyone
    opened the actual file. Nothing in the process caught it, because the claim was self-consistent
    everywhere it had been copied to.

**Prevention.** Re-read source documents **after** any change to what the working tree contains,
and quote a file only from the path currently under analysis. When reporting that document X
contradicts the code, cite `X:line` from the tree being examined — a claim that cannot name a line
in the current tree is not evidence. This is the documentation analogue of RM-18's lesson about
trusting a contaminated local environment.

**Nothing about the licensing position was ever in question.** `enterprise/` and
`IdentityManager.ts` are absent from the tree, `identity/` is wired, and `LICENSE.md` already
asserts Apache-2.0 in its entirety, backed by `CLEANROOM-ATTESTATION.md`. See
[`current-state.md`](current-state.md).

### RM-07 · Migration counts differ across engines

### RM-07 · Migration counts differ across engines

**Status:** OPEN · **Opened:** 2026-08-11 · **Unverified**

sqlite 53 · postgres 55 · mysql 57 · mariadb 56. `AGENTS.md §5` requires all four. Some of the
spread may be legitimately engine-specific and inherited from upstream.

**Action:** determine per migration whether each gap is intentional. If not, add the missing
migrations and a test asserting parity. Do not "fix" counts by generating stubs.

### RM-08 · QA documents are pinned to `3.1.4-fw8` while the tree is `fw10`

**Status:** OPEN · **Opened:** 2026-08-11

`testing.md`, `bug-log.md` and `release-readiness.md` describe the fw8 QA run. Whether each fw8
finding is closed, superseded or still open at fw10 is unverified.

**Action:** a `master-qa` run at fw10, appending a new dated section to each rather than
overwriting the fw8 record.

## Priority 4 — coverage gaps

### RM-09 · No secret, container or shell scanning available

**Status:** OPEN · **Opened:** 2026-08-11

`gitleaks`, `trufflehog`, `trivy`, `hadolint` and `shellcheck` are all absent from this machine.
`.github/workflows/security-scan.yml.disabled` is written and ready but deliberately not enabled —
enabling an unverifiable gate is the failure mode `PROCESS-GAPS.md` G1 warns against.

**Action:** install at least `gitleaks` and `hadolint`, verify each fires on a known-bad input and
passes on a known-good one, then rename the workflow to `.yml`.

### RM-10 · No Kubernetes or IaC

**Status:** OPEN · **Opened:** 2026-08-11 · **Roadmap, not a defect**

Docker and compose only. See [`platform-roadmap.md`](platform-roadmap.md). Run the
`kubernetes-readiness` skill before any cluster deployment is considered.

## Closed

_(none yet — this document was created 2026-08-11)_
