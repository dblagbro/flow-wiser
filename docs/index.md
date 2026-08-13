# Documentation index — what is authoritative for what

**Last updated: 2026-08-11**

Read this before trusting any other document. Where two documents disagree, the one named
**authoritative** here wins; the other is drift and should be fixed or reported.

Documents fall into two kinds:

-   **Standing** — describes how things are now, and is kept current. Update it when reality changes.
-   **Point-in-time** — a dated record of a run, decision or assessment. **Never rewrite it.**
    It is evidence. Add a new entry instead.

---

## Contract and process

| Topic                                                         | Authoritative                                          | Kind          |
| ------------------------------------------------------------- | ------------------------------------------------------ | ------------- |
| Project contract — rules any agent or contributor must follow | [`../AGENTS.md`](../AGENTS.md)                         | standing      |
| Claude Code specifics, environment hazards in this checkout   | [`../CLAUDE.md`](../CLAUDE.md)                         | standing      |
| **Clean-room process — binding**                              | [`CLEANROOM-PROTOCOL.md`](CLEANROOM-PROTOCOL.md)       | standing      |
| Clean-room provenance evidence                                | [`CLEANROOM-ATTESTATION.md`](CLEANROOM-ATTESTATION.md) | point-in-time |
| Licensing and compliance position                             | [`COMPLIANCE-POSTURE.md`](COMPLIANCE-POSTURE.md)       | standing      |
| Fork context, licensing boundaries                            | [`../FORK.md`](../FORK.md)                             | standing      |
| How the fork was created                                      | [`HOW-WE-DID-THIS.md`](HOW-WE-DID-THIS.md)             | point-in-time |

## Product and architecture

| Topic                                                           | Authoritative                          | Kind          |
| --------------------------------------------------------------- | -------------------------------------- | ------------- |
| Purpose, standing requirements, what is in and out of scope     | [`product.md`](product.md)             | standing      |
| Architecture, module boundaries, dependency direction           | [`architecture.md`](architecture.md)   | standing      |
| Structural map — entry points, routes, entities, queues, config | [`project-map.md`](project-map.md)     | standing      |
| What is actually true right now — shipped state                 | [`current-state.md`](current-state.md) | standing      |
| Significant decisions                                           | [`decisions/`](decisions/)             | point-in-time |
| Narrative history, findings, rejected approaches                | [`PROJECT-LOG.md`](PROJECT-LOG.md)     | append-only   |
| Public-facing status narrative                                  | [`STATUS.md`](STATUS.md)               | standing      |

**UI/design:** there is deliberately no `design.md`. A standing product requirement is that
`packages/ui` stays essentially unchanged, so there is no design surface this project owns.
If that changes, add `design.md` and list it here.

## Requirements and specification

| Topic                              | Authoritative                                                      | Kind          |
| ---------------------------------- | ------------------------------------------------------------------ | ------------- |
| Auth / RBAC requirements           | [`REQUIREMENTS-AUTH-RBAC.md`](REQUIREMENTS-AUTH-RBAC.md)           | standing      |
| Versioning requirements            | [`REQUIREMENTS-VERSIONING.md`](REQUIREMENTS-VERSIONING.md)         | standing      |
| Tenancy and access requirements    | [`REQUIREMENTS-TENANCY-ACCESS.md`](REQUIREMENTS-TENANCY-ACCESS.md) | standing      |
| Migration requirements             | [`REQUIREMENTS-MIGRATION.md`](REQUIREMENTS-MIGRATION.md)           | standing      |
| Clean-room interface specification | [`SPEC-AUTH-RBAC.md`](SPEC-AUTH-RBAC.md)                           | point-in-time |

## Quality

| Topic                                                      | Authoritative                                      | Kind          |
| ---------------------------------------------------------- | -------------------------------------------------- | ------------- |
| Test plan, environments, coverage matrix, toolchain status | [`testing.md`](testing.md)                         | standing      |
| Defect register                                            | [`bug-log.md`](bug-log.md)                         | standing      |
| QA run records                                             | [`qa-notes.md`](qa-notes.md)                       | append-only   |
| Issues and risks, with severity                            | [`ISSUE-REGISTER.md`](ISSUE-REGISTER.md)           | standing      |
| Refactor history                                           | [`refactor-log.md`](refactor-log.md)               | append-only   |
| Open remediation work — defects, drift, risk               | [`remediation-plan.md`](remediation-plan.md)       | standing      |
| Wanted features and operational tasks (not defects)        | [`backlog.md`](backlog.md)                         | standing      |
| Process failures and their controls                        | [`PROCESS-GAPS.md`](PROCESS-GAPS.md)               | append-only   |
| Recovery assessment                                        | [`RECOVERY-ASSESSMENT.md`](RECOVERY-ASSESSMENT.md) | point-in-time |

## Security

| Topic                     | Authoritative                            | Kind          |
| ------------------------- | ---------------------------------------- | ------------- |
| Reporting vulnerabilities | [`../SECURITY.md`](../SECURITY.md)       | standing      |
| Remediation briefs        | [`security/`](security/)                 | point-in-time |
| Advisory sweep            | [`ADVISORY-SWEEP.md`](ADVISORY-SWEEP.md) | point-in-time |

## Release and platform

| Topic                                | Authoritative                                    | Kind          |
| ------------------------------------ | ------------------------------------------------ | ------------- |
| Release gate status and criteria     | [`release-readiness.md`](release-readiness.md)   | standing      |
| User-visible change history          | [`../CHANGELOG.md`](../CHANGELOG.md)             | append-only   |
| Release notes                        | `RELEASE-NOTES-*.md`                             | point-in-time |
| Publication procedure                | `PUBLISH-*.md`                                   | point-in-time |
| Version baseline                     | [`BASELINE-3.1.4-fw8.md`](BASELINE-3.1.4-fw8.md) | point-in-time |
| Backup, recovery, irreplaceable data | [`backup-plan.md`](backup-plan.md)               | standing      |
| Container / K8s / cloud posture      | [`platform-roadmap.md`](platform-roadmap.md)     | standing      |

## Market

| Topic                                      | Authoritative                          | Kind            |
| ------------------------------------------ | -------------------------------------- | --------------- |
| Competitive, licensing and demand research | [`market-review.md`](market-review.md) | standing, dated |

---

## Known drift — 2026-08-11

Recorded rather than silently corrected, because these touch product and licensing claims.

1. ~~**`STATUS.md` is materially stale.**~~ **WITHDRAWN 2026-08-12 — this was raised in error.**
   The quoted phrases came from a **stale docs-only copy dated 2026-08-05** that occupied the
   working directory before the repository was checked out over it, not from `docs/STATUS.md`.
   The real file is dated 2026-08-09 and records the opposite: released, Apache-2.0-only, licensed
   files deleted, RBAC shipped. It needs no rewrite, and no licensing question was ever open.
   See RM-06 in [`remediation-plan.md`](remediation-plan.md) for how the error propagated.

2. **`testing.md`, `bug-log.md` and `release-readiness.md` are pinned to the `3.1.4-fw8` QA run**
   while `package.json` reads `3.1.4-fw10`. They are treated as authoritative _and_ standing:
   QA and release skills append new dated sections rather than replacing them.

3. **Node version is contested across three artifacts.** See
   [`decisions/ADR-0004-node-version-conflict.md`](decisions/ADR-0004-node-version-conflict.md).

## Rules for these documents

-   Every dated entry uses an **absolute date** (`2026-08-11`), never "today" or "recently".
-   **No secrets, credentials, tokens, private keys, PII or production data** — ever.
-   Never rewrite a point-in-time record. Add a new entry.
-   Stale documentation is a defect. Fix it, or record it here as drift — do not step around it.
-   **Licensing claims require evidence and human sign-off.** One was published incorrectly three
    times. No agent asserts license status as a side effect of other work.
