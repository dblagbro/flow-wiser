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

---

## G9 · CI was red for three days and every release shipped anyway

**What happened.** `pnpm install --frozen-lockfile` failed on every commit from `2993cc72`
(2026-08-05 22:38) to `b4f20a62` (2026-08-09 03:36). The cause was one line: the flow-versioning
work added `isomorphic-git@^1.27.1` to `packages/server/package.json` and never regenerated
`pnpm-lock.yaml`. Three security releases — fw5, fw6, fw7 — were built, published and deployed
across that window, including two that were handed to an external assessment team.

**Why it went unnoticed.** The signal existed and was ignored. Node CI reported failure on all ten
intervening runs. I was reading the clean-room guard, which was green, and treating that as *the*
gate because it was the one I had written and cared about. A workflow I did not author became
background noise.

The local build never reproduced it. The Docker build does not use `--frozen-lockfile`, so the image
resolved `isomorphic-git` fresh and worked; the container running in production is genuinely fine.
Only the reproducible-install path was broken — which is precisely the path that matters least
day-to-day and most when someone else tries to build the project.

**Why this is the same shape as G1b.** In G1b the clean-room guard passed for a reason unrelated to
the thing it was supposed to check. Here a red gate was disregarded for a reason unrelated to what it
was reporting. Both are the same error: treating a check's *status* as information about the
*project* rather than about the check. A gate is only worth having if a red one stops something.

**What it cost.** Nothing in production, by luck rather than design. But "the published source does
not install from its own lockfile" is a bad property for a fork whose entire pitch is that it is a
trustworthy continuation, and worse while an external team is auditing the repository.

**Fix applied.** Lockfile regenerated with pnpm 10.26.0 — the version CI pins — adding
`isomorphic-git@1.41.0` and four transitive dependencies. The diff was reviewed to confirm nothing
else moved.

**Fix still needed.** A release must not be tagged while any required workflow on that commit is
red. Right now nothing enforces that; I check by remembering to look, which is exactly what failed
here. Branch protection requiring Node CI and the clean-room guard would make this structural
instead of behavioural.

---

---

## G10 · A test suite was committed, counted as coverage, and never once executed

**What happened.** `packages/server/test/identity/recovery-cli.test.ts` holds 30 tests covering all
eight recovery CLI commands and `doctor` — the only evidence that REQUIREMENTS-MIGRATION §7 ("every
identity operation must be performable without a working UI and without a working login") actually
holds. It has never run in CI. Not once, in any build, since it was written.

**Three independent failures stacked.** That is why it stayed invisible, and why fixing any one of
them changed nothing observable:

1. `pnpm install --frozen-lockfile` failed (G9), so jest never started.
2. A pnpm override forced an ESM-only `@tootallnate/once` into a CJS require chain, so the suite
   failed to *parse* — reported as "Test suite failed to run", which reads like an environment
   grumble rather than 30 missing tests.
3. `jest.config.js` mapped `typeorm` to a decorator mock for every file, so the suite's real
   `DataSource` was a stub without `initialize()`. Every test would have died on its first fixture
   line even if it had parsed.

Each layer had to be removed before the next became visible. Three days of green-looking local work
sat on top of it.

**The file said so, and that was not enough.** Its docblock openly documented that `pnpm test` would
not pick it up and gave a hand-run `npx jest` invocation with three overrides. That is a comment
asking a human to remember something, which is not a control. Written-down knowledge that a check is
disabled reads, at a glance, exactly like a check that is enabled.

**What it hid.** Once the suite ran, five assertions failed — all of them encoding schema defects
that `1780000000012-AddTenancyColumnsToCoreTables` had since *repaired* (the dangling
`chat_flow → workspace` foreign key, and nine tables missing `workspaceId`). So the tests were not
merely absent; they had silently drifted into asserting a broken state as correct. Had they run at
the time, they would have failed the moment that migration landed and forced the question then.

**Also wrong, and worth naming separately:** the `@tootallnate/once` override was incorrect on its own
terms. The advisory it exists for (GHSA-vpq2-c234-7xj6) patches *two* release lines, 2.0.1 and 3.0.1;
the override jumped to `>=3.0.1`, an ESM-only major that neither consumer
(`http-proxy-agent@4`, `@5`, which declare `1` and `2`) was written against. `>=2.0.1 <3` satisfies
the advisory and stays CJS. A security pin that breaks the build is a security pin that gets worked
around.

**Fix applied.** Override corrected; `jest.config.js` split into `stubbed-orm` and `real-orm`
projects so a suite needing a real database gets one; the five stale assertions flipped to assert the
repaired state rather than deleted, so a check that stops running stays distinguishable from a defect
that got fixed. Suite passes 30/30. Package total went from 937 tests to 974.

**Fix still needed.** Nothing detects a suite that exists but never runs. A collected-test-count
floor in CI, or a check that every `*.test.ts` on disk appears in the run report, would have caught
this in a day instead of never.

**Postscript — a fourth layer.** With install, lint, build and the unit tests all green, the job
failed one step further on: Cypress starts the server with `pnpm start` and no environment, so it
died at boot with `KeyringError: no encryption key configured`. That is the keyring behaving exactly
as designed — it never invents a key, because a generated key silently strands every credential
written under the previous one — but the Cypress step was configured before the identity layer
existed and was never given one. It has been failing that way ever since, invisible behind the three
failures above it. The same missing variable took the site down during the fw5 deploy. Fixed by
setting throwaway `IDENTITY_ENCRYPTION_KEY` and `FLOWISE_SESSION_PEPPER` values in the workflow,
checked in rather than stored as repository secrets so a fork can still get a green build.

**Count the layers: four.** Each one had to be removed before the next was even visible, and each
looked like the whole problem while it was on top. This is the real lesson of G9 and G10 — a build
that has been red for a while is not one bug, and "I fixed the failure" is not the same claim as
"the build is green."

---

## Controls added 2026-08-09 — what now enforces G9 and G10

Both gaps ended with "fix still needed", which is a note to nobody. These are the mechanisms.

| Gap | Was | Now |
|---|---|---|
| G9 · released on a red build | nothing looked | branch protection on `main` (required: `guard`, `build (ubuntu-latest, …)`, `enforce_admins` ON, force-push and deletion blocked) + `release-gate.yml` |
| G10 · a suite that never ran | nothing looked | `scripts/assert-test-discovery.js`, run inside Node CI |

**`release-gate.yml` — honest about its limits.** It cannot stop a tag being created: Actions runs
after the ref is written and a hosted repository has no pre-receive hook. What it does is attach a
red X to the tag, and — on `release: published` with a red commit — revert the release to a draft.
That second part is a real gate rather than a notification: nothing is destroyed, notes and assets
survive, and it stops being something a user can find. **Docker Hub is not covered**, because nothing
in CI pushes there; Flow-Wiser images are built and pushed by hand. That is stated in the workflow
rather than left to be assumed.

**`assert-test-discovery.js` — why not a test-count floor.** A floor has to be revised every time
someone legitimately deletes a test, so it drifts downward until it asserts nothing, and it cannot
tell "we removed 30 tests on purpose" from "30 tests stopped being discovered". Comparing the
filesystem against `jest --listTests` — Jest's own answer, not a re-implementation of its resolution
— asks the real question. Exclusions are allowed but must be declared with a reason, because an
undeclared exclusion is the entire defect.

**It was tested against the actual failure**, not just written. Reproducing the G10 condition
(recovery-cli ignored by one project and unmatched by the other) makes it exit 1 and name the file.
The first attempt at that negative test passed when it should have failed — the mutation let the
other project pick the file up — which is worth recording: a control nobody has watched fail is a
control nobody has tested.

**`enforce_admins` is ON.** It was off for one day while CI was being repaired, because turning it on
with a red build would have locked out the fixes. The cost is real: direct pushes to `main` are now
rejected until checks pass, so an emergency fix needs a PR or a deliberate, logged un-protection. That
is the intended cost. The previous setting logged `Bypassed rule violations` and let the push through,
which is a receipt, not a gate.

