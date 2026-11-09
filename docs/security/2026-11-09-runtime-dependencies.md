# Runtime dependency and workspace-control reconciliation — 2026-11-09

Status: local lint, full build, discovery and tests passed; Docker image and CI validation are pending. This is not a new release or a claim that this Git revision is deployed.

The maintained main branch and the running custom fork had diverged. This change brings the tested runtime/dependency strategy into source and preserves workspace credential controls already present on apache2-only and in the deployed custom source.

-   Align Node declarations to major 22, with exact pins 22.23.4, and pnpm 10.34.5. Port runtime/ignore controls and FAISS installation resilience from PR #24 (db44243a306d71441cba9b7900c5dfa15667bde6), preserving main's newer vm2 3.12.2 and other unrelated fixes. The existing proprietary-path CI guard remains present.
-   Apply the dependency bounds used for the November 9 custom rebuild and regenerate the lockfile. Add the UUID declarations needed by the real ORM tests.
-   Build from the frozen lockfile and keep the production dependency graph in the runtime filesystem. Retain image version, secret and licensed-artifact build gates.
-   Port existing workspace credential checks and their component tests from apache2-only. Three sampled deployed source files matched that branch byte for byte. Include the matching voice-service ownership check and a negative test proving a foreign credential cannot reach the provider.
-   Keep the clean-room pre-commit guard chained through Husky reinstallations. No protected enterprise sources or production secrets were read or copied.

## Evidence and outstanding checks

The parity control failed on the previous main declarations/ignore lists and passed after the change: 11 declarations on Node 22, exact pins 22.23.4, and all three ignore lists carry the required markers. Lockfile resolution completed successfully. The subsequent full local build, lint and discovery gate passed. All 3,597 tests in 157 suites across five packages passed with zero cached tasks. The new TTS credential-isolation regression fails on the previous main service for the expected unauthorized provider access and passes with the fix.

Remaining before merge: Docker image build/gates and acceptance checks, and CI on the actual PR revision. Existing versioning PRs #60/#61 are separate and are not merged by this change.

The independently deployed custom derivative used Node 22.23.4, passed 36 targeted security/recovery tests and isolated login/private-flow/logout checks. Its previously recorded package scan moved from 25 Critical / 471 High to 3 Critical / 74 High. Those results identify that derivative image, not this source revision, and are not relabeled as newly rerun tests. Remaining matches include expr-eval and build-tool Go libraries; applicability/vendor follow-up remains open. No external model or SMTP acceptance test was performed.
