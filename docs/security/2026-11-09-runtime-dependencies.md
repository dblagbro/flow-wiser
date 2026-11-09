# Runtime dependency and workspace-control reconciliation — 2026-11-09

Status: local lint, full build, discovery, tests and source-image acceptance passed. GitHub browser CI is being repaired; no source release or deployment is claimed. This is not a new release or a claim that this Git revision is deployed.

The maintained main branch and the running custom fork had diverged. This change brings the tested runtime/dependency strategy into source and preserves workspace credential controls already present on apache2-only and in the deployed custom source.

-   Align Node declarations to major 22, with exact pins 22.23.4, and pnpm 10.34.5. Port runtime/ignore controls and FAISS installation resilience from PR #24 (db44243a306d71441cba9b7900c5dfa15667bde6), preserving main's newer vm2 3.12.2 and other unrelated fixes. The existing proprietary-path CI guard remains present.
-   Apply the dependency bounds used for the November 9 custom rebuild and regenerate the lockfile. Add the UUID declarations needed by the real ORM tests.
-   Build from the frozen lockfile and keep the production dependency graph in the runtime filesystem. Retain image version, secret and licensed-artifact build gates.
-   Port existing workspace credential checks and their component tests from apache2-only. Three sampled deployed source files matched that branch byte for byte. Include the matching voice-service ownership check and a negative test proving a foreign credential cannot reach the provider.
-   Keep the clean-room pre-commit guard chained through Husky reinstallations. No protected enterprise sources or production secrets were read or copied.

## Evidence and outstanding checks

The parity control failed on the previous main declarations/ignore lists and passed after the change: 11 declarations on Node 22, exact pins 22.23.4, and all three ignore lists carry the required markers. Lockfile resolution completed successfully. The subsequent full local build, lint and discovery gate passed. All 3,597 tests in 157 suites across five packages passed with zero cached tasks. The new TTS credential-isolation regression fails on the previous main service for the expected unauthorized provider access and passes with the fix.

Remaining before merge: GitHub CI on the final PR revision, including the active browser authentication suite. Existing versioning PRs #60/#61 are separate and are not merged by this change.

The independently deployed custom derivative used Node 22.23.4, passed 36 targeted security/recovery tests and isolated login/private-flow/logout checks. Its previously recorded package scan moved from 25 Critical / 471 High to 3 Critical / 74 High. Those results identify that derivative image, not this source revision, and are not relabeled as newly rerun tests. Remaining matches include expr-eval and build-tool Go libraries; applicability/vendor follow-up remains open. No external model or SMTP acceptance test was performed.

## Image and CI evidence (08:15 UTC update)

Candidate `sha256:5317fe820df3e625dd3295a9f7b302c5f09134d13d59f248f830620289132574`, built from the application/build files in `c8e4c7835be37cc2b4e5fb0be4ddc5ab91b5ba3e`, passed the Docker version/secret/licensed-artifact gates. SQLite, FAISS and Sharp load. Isolated restored-database admin creation, forced password change, login, 25-flow list/read, anonymous private-flow/credential denial, logout and session revocation passed. The clone had no published ports, production NAS or outbound network access and is now stopped. A fresh scan of this candidate reports 3 Critical / 74 High package matches; these residual findings are not declared fixed.

GitHub Docker CI passed. Node CI passed lint, build, discovery and coverage, then twice failed before Cypress could run because the action used an affected `got` release under the runner's Node 24 runtime. [Cypress issue #1873](https://github.com/cypress-io/github-action/issues/1873) documents the error; [v7.4.4](https://github.com/cypress-io/github-action/releases/tag/v7.4.4) fixes it. Both action references are pinned to that release's verified commit. The two legacy CRUD browser specs are entirely commented out, so an active three-check authentication-boundary suite is added. It tests real UI rendering, protected-page navigation and anonymous API denial. Legacy CRUD coverage remains absent. CI is still required after this change; it is not skipped or marked successful by these notes.

The initial native-module probe addressed an unexported package.json subpath. Correcting the harness to resolve the public component entry point passed without changing the image. Earlier Docker build attempts and their diagnostics are retained in the operator evidence.

## Browser fixture and required-check naming

The repaired Cypress action now runs all three browser checks. The first run passed sign-in rendering and anonymous API denial, while protected-page navigation correctly reached first-time organization setup because CI had an empty database. The suite now initializes a disposable account through the supported recovery CLI before testing the configured-instance redirect. Public self-registration is intentionally unavailable in this fork. The fixture refuses database paths outside the exact temporary CI directory and generates its password in memory. It does not weaken the expected sign-in redirect or API denial assertions.

The Node job has the stable check name `Node CI (ubuntu-latest)`. The main branch's existing required check still names Node 24.15.0; after the new check passes, its required-check context must be migrated to `Node CI (ubuntu-latest)`, preserving the guard requirement, GitHub Actions app binding and all other protections. Until that migration and final CI success, this PR must not merge.

The Cypress action exports `CI=1` during installation (its pinned `index.js`, line218). The fixture accepts both standard true values, `1` and `true`, while retaining the exact temporary database-path check. The initial strict-value assertion failed before any account creation; it did not indicate an application authentication failure.

The corrected fixture passed locally in a fresh, isolated instance of the previously validated source candidate: `CI=1` account creation succeeded, and an unexpected database path was refused before mutation. The test container was stopped afterward. This validates the fixture; final GitHub browser CI remains required.

The fixture completed successfully in GitHub, then the test assertion used a result property absent from the repository-pinned Cypress version. The suite now checks the fixture success output; `cy.exec` still fails on every non-zero exit by default. No application or fixture isolation behavior changed.

A later CI attempt failed inside account creation, although the same fixture had succeeded locally and in the preceding CI run. The fixture now emits a bounded, password-redacted CLI diagnostic on failure; this intermittent failure remains unresolved and blocks merging.

The diagnostic identified a duplicate synthetic account, not a password or database-lock error. Fixture setup now reuses only the exact synthetic identity after checking both workspace and organization membership; it never resets a password or overwrites an account. Each workflow run/attempt also gets a distinct temporary database path. Final browser CI remains required.

The revised fixture passed fresh isolated account creation, a second invocation reusing the verified identity, and wrong-path refusal. The canary was stopped after testing.
