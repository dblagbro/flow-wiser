# ADR-0001 — Clean-room replacement of the licensed subsystem

**Status:** Accepted
**Date:** 2026-08-05 (recorded as an ADR 2026-08-11)
**Decided by:** Operator

> Retrospective ADR. The decision was made and acted on before this record existed; it is written
> down here because it constrains every future change and must not be silently reversed. Sources:
> [`PROJECT-LOG.md`](../PROJECT-LOG.md), [`CLEANROOM-PROTOCOL.md`](../CLEANROOM-PROTOCOL.md),
> [`STATUS.md`](../STATUS.md).

## Context

FlowiseAI announced end-of-life on 2026-08-03. At the fork point roughly 5% of the tree — 127
files — was under FlowiseAI's Commercial License rather than Apache-2.0. That 5% was one coherent
subsystem: authentication, SSO, RBAC and multi-tenancy.

It was also load-bearing. Flowise 3.x had removed the Apache-2.0 auth, so deleting those files
without a replacement produces an unauthenticated server, not a smaller one.

Two facts made an independent reimplementation viable without ever opening them:

-   `packages/ui` is 100% Apache-2.0 and contains the **complete HTTP contract** — every endpoint,
    payload and response.
-   The Apache-2.0 route files contain permission call sites that define the middleware contract.

The whole interface is therefore derivable from code the project has full rights to read.

## Decision

Replace the commercially-licensed subsystem with original Apache-2.0 work, specified **solely**
from Apache-2.0 sources, and delete the originals. **Never read the licensed files.**

Enforced mechanically rather than by intention: `.githooks/pre-commit` and a CI workflow reject
any commit that _modifies_ `packages/server/src/enterprise/` or `IdentityManager.ts`. Deletion is
permitted — removing them is the goal. **Editing is blocked, because editing implies reading.**

New identity tables are `identity_`-prefixed and were initially unregistered, so old and new
stacks could coexist and the running server stayed unaffected until cut-over.

## Consequences

-   The interface specification was written before the implementation, and git history proves the
    order — the paper trail _is_ the defence.
-   The prohibition **survives deletion**. It applies to every branch, tag, historical commit and
    restored copy, forever. Absence from the working tree is not permission.
-   Work is publishable in the open, including unfinished, because provenance is verifiable.
-   Clean-room does **not** defeat patents; independent invention is no defence to a patent claim.
-   A licensing claim still requires a full provenance audit and human sign-off — the replacement
    existing is not itself a determination. See [`current-state.md`](../current-state.md).

## Alternatives considered

-   **Keep the licensed files and ship as-is.** Rejected: contradicts requirement R1, and the files
    are not redistributable under Apache-2.0.
-   **Delete them without a replacement.** Rejected: yields an unauthenticated server.
-   **Reverse engineer them.** Rejected — see [ADR-0002](ADR-0002-no-reverse-engineering.md).
-   **Declare the repository Apache-2.0 as-is.** Rejected: void. No fork can relicense code it does
    not own, and it would be a lie.

**Legal grounding** (background, not advice): 17 U.S.C. §102(b); _Google v. Oracle_, 593 U.S. \_\_\_
(2021); _Sega v. Accolade_, 977 F.2d 1510 (9th Cir. 1992); _Sony v. Connectix_, 203 F.3d 596
(9th Cir. 2000); the Phoenix BIOS clean-room methodology. Counsel should review the specification
and attestation before an Apache-2.0-only build is published.
