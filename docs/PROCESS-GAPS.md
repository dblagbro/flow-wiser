# Root-cause and process-gap analysis

**Date:** 2026-08-07 · Blameless. The purpose is to fix controls, not to assign fault.

Context: on 2026-08-06 a large amount of work was completed in one session — the commercial-code
removal, identity/RBAC/MFA/audit/tenancy, migration tooling, a recovery CLI, and git-backed
versioning. Most of it works. But a striking share of the session's effort went into repairing
defects introduced earlier **in that same session**, and one incorrect licensing claim was published
three times. This analyses why.

---

## G1 — The clean-room controls were never in force

**Evidence.** `gh run list` over 60 runs: `Proprietary Path Guard` skipped 57/57; `Node CI` 1 run,
failed; `Clean-room guard` 1 run. Trigger blocks: Node CI fires on `push: branches: [main]` only,
while all work is on `apache2-only`. Proprietary Path Guard is gated
`if: github.repository == 'FlowiseAI/Flowise'` — upstream's own workflow, inherited by the fork,
structurally incapable of running here. `git config core.hooksPath` is unset, so the pre-commit
hook never runs in a fresh clone — which is how every delegated agent worked.

**Root cause.** Controls were **written and documented but never observed to execute**. Their
existence was taken as evidence of their operation.

**Impact.** The single most serious defect of the project — commercially licensed source in the
repository and in three published images — went undetected, while the documentation asserted a
guard was preventing exactly that.

**Detection that should have caught it.** Any one of: reading `gh run list` once; deliberately
committing a violation to confirm the guard rejects it; checking `core.hooksPath` in a fresh clone.

**Corrective action (done 2026-08-07).** Guard rewritten: runs on `branches: ['**']`, checks the
**whole tree** rather than a diff, counts licensed content **inside patch hunks**, and asserts
`.dockerignore` excludes the archive. **Regression-tested against the actual failure** — it passes
at `7e7c5a9e` and fails at `c2086b45` with 9,715 licensed lines detected.

**Prevention.** A control is not in place until it has been **observed failing on a known-bad
input AND passing on a known-good one, in the environment that actually runs it**. Both halves are
required — see G1b.

---

## G1b — The rewritten guard failed on its first real run, because the tree was clean

**Evidence.** The new guard was regression-tested locally: it passed at `7e7c5a9e` and failed at
`c2086b45` with 9,715 licensed lines. Pushed, it ran on `apache2-only` for the first time in
project history — and **failed**, emitting no `::error::` at all.

**Root cause.** CI runs steps under `bash -e`, and the script sets `-o pipefail`.
`find packages/server/src/enterprise ... | wc -l` returns non-zero when the directory is **absent**,
which fails the command substitution, which aborts the step before any check executes. The guard
therefore failed *precisely because the commercially licensed directory no longer exists*.

My local regression test passed because I ran the logic in a plain interactive shell, without
`-e` and without `pipefail`. **The logic was right; the environment was not reproduced.**

**Impact.** Had this not been checked, the "fixed" guard would have been red on every push — the
condition under which teams disable a guard rather than read it.

**Prevention.** Test CI shell fragments under `bash -e` with `pipefail`, not in an interactive
shell. Note the specific trap: with `pipefail`, `find` on a missing path fails the pipeline, so
every "check that something is absent" is a `set -e` hazard.

---

## G2 — Verification was scoped to the subtree being edited

**Evidence.** "100% Apache 2.0, 2,317 source files, 0 commercially licensed" was measured over
`packages/`. `upstream-archive/` (701 files) was never examined. `COPY . .` with no `.dockerignore`
put 71 MB of it into every image.

**Root cause.** The claim was about the **repository and its artifacts**; the measurement was about
the **directory being worked in**.

**Detection.** Search the **built image**, not the source tree. The release pass found it in minutes
by running `find / -xdev -ipath '*enterprise*'` inside the image.

**Prevention.** Any claim of the form "the project contains no X" must be verified against the
build output, and the verifying command must be recorded next to the claim.

---

## G3 — A scan reporting "clean" was not distinguished from a scan that did not run

**Evidence.** During the release audit, the first two content sweeps of the image returned **0 hits
for everything**. BusyBox `grep` had silently no-op'd on `-I` and `apk add grep` had failed. Only a
**positive control** (`Apache License` → 10,804 hits) revealed the sweep was inert.

**Root cause.** Absence of evidence read as evidence of absence.

**Prevention.** Every "we searched and found nothing" result must carry a positive control that
*did* fire. Adopted as standing practice.

---

## G4 — Completion was declared from code existing, not from the path executing

Three instances, all found only by running the system:

| Defect | Why review missed it |
|---|---|
| `mustChangePassword` never cleared by any code path — fresh install **bricked** | Every component was individually correct; only the end-to-end first login exposed the missing exit |
| `BootstrapService` had **zero callers** — six-role hierarchy never seeded, `FLOWISE_BOOTSTRAP_*` inert | The class was complete, documented, and tested-looking. Nothing imported it. |
| `type: 'timestamp'` invalid on SQLite — after "fixing" `datetime`, which is invalid on Postgres | Migrations emit correct per-engine SQL, so migration testing passed; only entity metadata at real boot exercised it |

**Root cause.** Reading verifies *shape*. Only execution verifies *reachability*.

**Prevention.** For any new subsystem, one acceptance criterion must be an executed path from the
real entry point — not a unit test with injected dependencies. Note that `BootstrapService`'s unit
tests **passed** while nothing called it in production.

---

## G5 — Test infrastructure hid its own gaps

**Evidence.** 32 suites collected; 4 fail to **load**; summary reports `844 passed`. A suite that
cannot load contributes zero tests, so the headline number is identical whether its 30 tests pass,
fail, or do not exist. `recovery-cli.test.ts` (30 tests, the entire recovery CLI) has **never run**.

Two distinct causes, both mundane: the `typeorm` mock lacked `ViewColumn` (used by `LoginActivity`,
a database view), and `flowise-components` was not mapped to its existing mock. Fixing both makes
the suite load — and then all 30 fail, because it needs **real** TypeORM against a real SQLite file
while the config globally mocks TypeORM for the 29 unit suites. That is a structural conflict
requiring a jest `projects` split, not a configuration tweak.

**Impact.** Versioning — an entire feature, including the module that carried a path-traversal
write — has **zero** tests. The recovery CLI's tests exist but are inert.

**Corrective action (partial).** `ViewColumn`/`ViewEntity` added to the mock. The
`flowise-components` mapping was **deliberately reverted**: alone it converts a silent load failure
into 30 loud failures without making them pass. Recorded as a first-milestone task.

**Prevention.** CI must fail on **suite-load failures**, not only on assertion failures. Track
*suite count* as a metric, not just test count.

---

## G6 — Parallel agents duplicated work through stale clones

**Evidence.** The password-change endpoint was implemented **twice**, independently — once by me and
once by a delegated agent that had cloned minutes before my push, so its report ("this exists on no
branch") was accurate at clone time and stale on delivery. Same for the `getRunningExpressApp`
DataSource fix. Two merge conflicts and a duplicate `AUTH_PASSWORD_CHANGE` enum entry followed.

**Root cause.** Delegation briefs described work to be *done* without a commit SHA establishing what
already *existed*.

**Prevention.** Every delegation brief states the base SHA and the agent re-fetches before starting.
Do not delegate work adjacent to something being actively edited.

**Also:** an agent checked out its branch in a working directory I was using, and I committed onto
its branch twice without noticing. Agents get their own clone or worktree, always.

---

## G7 — Scripted structural edits produced broken code three times

**Evidence.** Unescaped backticks terminated template literals in generated MySQL migrations; a
method was inserted into the wrong function body by `rindex`; a `sed` produced a duplicate enum key.
Each was caught by the compiler, none by review.

**Prevention.** Use string-anchored edits with a uniqueness assertion. If a structural edit must be
scripted, compile before committing. (Targeted edits have not failed once; scripted edits have
failed three times.)

---

## G8 — Cost and duplication

The session ran ~5 delegated agents and rebuilt the container image **~15 times** at ~4 minutes
each. Two rebuilds were wasted testing a stale image because a "build finished" check matched an
early log marker rather than `naming to docker.io`.

**Prevention.** Wait on the terminal marker. Batch related fixes into one build. Prefer running the
existing image's test suite over a rebuild when only test config changed.

---

## What worked, and should be kept

- **Adversarial verification by a second agent** found the security bug, the bricked install, and
  the licensing leak. Every one was invisible to inspection.
- **Agents reporting what they did NOT fix** — each delegation returned an explicit "broken but out
  of scope" list, which is where several of these findings originated.
- **Fatal-by-design startup.** Making `initDatabase` rethrow turned a confusing half-started server
  into an immediate, named failure, and caught the DataSource bug instantly.
- **Positive controls** (G3), now standing practice.
