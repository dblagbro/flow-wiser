---
name: master-qa
description: Full release-grade QA sweep across every domain — static, API, security, UI, ops/CLI, data and infrastructure — against disposable environments with a surface inventory driving coverage. Use before a release or after major change. Use daily-qa for routine checks.
---

# master-qa

An independent, evidence-driven sweep. The standard is that **coverage is derived from an
inventory**, not from intuition, and that every claim is demonstrated.

## 1. Orient

Read `AGENTS.md`, `docs/testing.md` (the environment discipline this project actually uses),
`docs/bug-log.md`, `docs/qa-notes.md`, `docs/ISSUE-REGISTER.md`, `docs/release-readiness.md`.

```bash
cd /mnt/s/code/flow-wiser
git rev-parse --abbrev-ref HEAD && git rev-parse HEAD && git status --porcelain
jq -r '.version' package.json
```

Record exactly what is under test: commit, version, image, and where it is deployed.

## 2. Build the surface inventory

Before testing anything, count the surface — use the **cartographer** agent if available:

server route groups · identity route files · CLI commands · migrations per engine · entities ·
test files · UI routes · queue consumers · compose services in scope · IaC/K8s manifests

Coverage is then expressed against this inventory. **Anything not covered is stated as a
coverage limit**, not left silent. Silence reads as coverage.

## 3. Environment discipline — non-negotiable

-   **PROD is read-only. GET only.** Fingerprint the production database before starting and
    re-check at teardown; if it changed, the run is void and its results are suspect.
-   QA instances are **standalone disposable containers with their own volumes**, deliberately not
    part of the shared compose stack — this host runs ~113 unrelated services.
-   Use separate instances for API/ops testing and UI testing, so session-revocation tests cannot
    destroy the UI run.
-   **Never** `docker compose down`, `docker volume rm`, or `docker system prune`.

## 4. Domains

Run each with the **qa-engineer** agent, and the security domain with **security-reviewer**
(verify each agent file exists first; otherwise run inline to the same standard):

| Domain   | Focus                                                                                                                                                            |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| STATIC   | clean build from scratch, lint, types, all suites actually discovered and run, migration parity across four engines, dependency resolution of the **final** tree |
| API      | authz on every route, cross-tenant IDOR, unauthenticated access to private objects, credential redaction, input handling, error hygiene                          |
| SECURITY | auth/session/MFA, secrets and defaults, SSRF (incl. IPv6 `::`, redirects, rebinding), sandbox/`require` allowlists, dependency advisories                        |
| UI       | first-login and password-change gates, error boundaries, empty/error API responses, accessibility                                                                |
| OPS      | CLI commands, backup/restore, encryption-key handling, audit export verification, doctor checks                                                                  |
| DATA     | migrations up and down on all four engines, tenancy keys populated, no orphaned references                                                                       |
| INFRA    | image build, pinning assertions, PID 1, healthcheck, non-root, `.dockerignore`, exposed surface                                                                  |

Probe the first-run/bootstrap path deliberately — it is rarely exercised and has broken here before.

## 5. Verify fixes on the artifact

A fix in the tree is not a fix in the image, and an image that is not deployed has fixed nothing
in production. Verify against the **built image**, and state which of the three levels you
confirmed. This distinction has repeatedly mattered on this project.

## 6. Teardown

Remove every QA container, volume and test credential you created. Confirm the production
fingerprint is unchanged. Report anything left behind — leftover QA artifacts are a finding.

## 7. Record

`docs/qa-notes.md` (the run), `docs/bug-log.md` (each finding, ID + severity + evidence +
demonstrated-vs-latent), `docs/ISSUE-REGISTER.md` (risks), `docs/testing.md` (the plan and
coverage matrix actually executed).

## 8. Stop before

Pushing, publishing, deploying, rotating live credentials, or any production mutation. Rotation
and redeploy are operator actions — recommend, never perform.

## 9. Report

```
MASTER QA — <date>
Under test  <commit> / <version> / <image> / deployed: <where>
Inventory   <surface counts>
Coverage    <domain: covered / limits>
Findings    <ID · severity · demonstrated|latent · one line>  (most severe first)
Blockers    <n>
Artifact    fixed-in-tree <n> · in-image <n> · deployed <n>
Teardown    <confirmed / what remains>
Prod DB     fingerprint UNCHANGED | CHANGED — run void

STATUS: PASS | FAIL — <n> blocking | BLOCKED — <need> | REVIEW REQUIRED — <decision>
```
