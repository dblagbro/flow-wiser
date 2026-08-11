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

### RM-04 · CI workflow execution is unverified on this branch

**Status:** OPEN · **Opened:** 2026-08-11

`cleanroom-guard.yml`, `proprietary-path-guard.yml` and `release-gate.yml` exist, but whether they
**ran on `ffae9952`** has not been confirmed. `PROCESS-GAPS.md` G1 records `Proprietary Path Guard`
skipping 57/57 runs because it was gated `if: github.repository == 'FlowiseAI/Flowise'` — inherited
from upstream and structurally incapable of running in a fork.

**Action:** inspect recent runs; confirm each required check executed on this branch and that
`skipped` is not being counted as `success`.

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

### RM-06 · `STATUS.md` contradicts the tree — REVIEW REQUIRED

**Status:** OPEN · **Opened:** 2026-08-11 · **Needs a human**

Dated 2026-08-05, it states the auth/RBAC replacement is "not started", entities are "not
registered", "no route file points at the new RBAC", and the licensed files are "not deleted".
All four are contradicted by observation at `ffae9952` — see [`current-state.md`](current-state.md).

It is **public-facing and contains licensing claims**. An incorrect licensing claim has already
been published three times on this project. A human rewrites this one.

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
