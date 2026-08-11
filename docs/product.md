# Product

**Last updated: 2026-08-11**

What Flow-Wiser is for, and the requirements that constrain every change. Narrative history and
the reasoning behind these lives in [`PROJECT-LOG.md`](PROJECT-LOG.md); this is the standing
statement.

## Purpose

Flow-Wiser is a community continuation fork of FlowiseAI's Flowise — a visual builder for LLM
flows and agents. FlowiseAI announced end-of-life on 2026-08-03 (code freeze 2026-07-29,
repository archived 2026-08-10, maintainers departing 2026-08-31), explicitly encouraging forks:
_"the Apache 2.0 licensed code is yours to keep building on."_

The fork exists to keep a working, patched, fully open Flowise available — and to finish the part
upstream never opened.

## Goals, in priority order

1. **A fully Apache-2.0 build.** Replace the commercially-licensed auth / SSO / RBAC /
   multi-tenancy subsystem with original clean-room work. This subsystem is load-bearing: 3.x
   removed the Apache-2.0 auth, so deleting the licensed files without a replacement yields an
   unauthenticated server.
2. **Different and better, not a clone.** Server-side-enforced RBAC, real MFA, SSO, one unified
   append-only audit trail, encryption at rest with honest threat modelling.
3. **Flow and prompt versioning** with non-destructive restore — recovering an old version writes
   a _new_ commit, so the version moved away from stays recoverable.
4. **A patched, deployable image** on `main`, for people who need Flowise working today.

## Standing requirements

These come from the operator, repeatedly and explicitly. They are not up for renegotiation by an
agent.

| #   | Requirement                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------- |
| R1  | 100% open source — remove all commercially-licensed files                                                               |
| R2  | **Different and better** function, not a clone                                                                          |
| R3  | **Keep the original UI essentially unchanged** — `packages/ui` is already Apache-2.0                                    |
| R4  | **Never read the proprietary files** while building replacements — see [`CLEANROOM-PROTOCOL.md`](CLEANROOM-PROTOCOL.md) |
| R5  | Full flow + prompt versioning with non-destructive restore                                                              |
| R6  | RBAC may be a full rewrite; it need not follow upstream's design                                                        |
| R7  | Open-source building blocks welcome where they help                                                                     |
| R8  | **No secrets, keys or PII in anything published**                                                                       |
| R9  | Publish to both GitHub and Docker Hub                                                                                   |

## Capabilities that differentiate the fork

-   **RBAC with real enforcement.** Upstream left 21 permissions with no server-side check — the
    client rendered buttons as `null` rather than disabling them, making those checks cosmetic.
    Flow-Wiser enforces server-side, deny-by-default, workspace-scoped, and audited.
    **A UI-only check is not a permission.**
-   **SSO and MFA.** The SSO _client_ already existed in the Apache-2.0 UI (Google, Azure, GitHub,
    Auth0) — only the server was proprietary. MFA never existed upstream at all; TOTP with hashed
    recovery codes is genuinely new.
-   **Versioning with history.** Git-backed, non-destructive restore.
-   **Honest containers.** Version-pinned builds that assert installed-equals-requested and fail
    loudly, after upstream shipped three images whose tags and contents disagreed.

## Explicitly rejected

Recorded so nobody proposes them again. Reasons in [`PROJECT-LOG.md`](PROJECT-LOG.md).

-   **Reverse engineering the licensed files, including via another LLM.** Unnecessary — the
    interface is derivable from Apache-2.0 sources. Actively harmful: it manufactures a
    derivative-work argument where none currently exists. _The absence of reverse engineering is
    the project's strongest asset._
-   **A companion service in another language to sidestep licensing.** Copyright protects
    expression, not language choice or process boundaries. Legitimate as an architecture choice;
    worthless as a legal one.
-   **Declaring the repository Apache-2.0 without evidence.** No fork can relicense code it does
    not own, and an unevidenced claim has already been published incorrectly three times.

## Out of scope

-   Changing the UI's look, structure or interaction model beyond what a fix requires (R3)
-   Trademark use — Apache-2.0 §6 grants no trademark rights; Flow-Wiser has its own identity
-   Reimplementing upstream's proprietary design for its own sake (R2/R6)
-   Legal advice. Documents may describe licences and cite public sources; **counsel must review
    anything consequential.**

## Audience

Operators running Flowise who need a patched, maintained, fully open build; contributors
continuing the project; organisations requiring enforced RBAC, SSO and MFA without a commercial
licence.
