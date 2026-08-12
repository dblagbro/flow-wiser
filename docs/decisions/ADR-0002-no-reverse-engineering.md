# ADR-0002 — No reverse engineering, including via an LLM

**Status:** Accepted
**Date:** 2026-08-05 (recorded as an ADR 2026-08-11)
**Decided by:** Operator

> Retrospective ADR. Recorded separately from [ADR-0001](ADR-0001-clean-room-replacement.md)
> because it is the approach most likely to be re-proposed — it looks efficient, and the reason
> it is rejected is not obvious from the code. Source: [`PROJECT-LOG.md`](../PROJECT-LOG.md).

## Context

The fastest-looking route to replacing the licensed subsystem is to read it and rewrite it —
or, more tempting still, to feed the files to a model and have it summarise, port or
"reimplement" them. Both appear to save weeks.

This proposal recurs, because each time it is raised it looks like a shortcut with no downside.
It has a downside, and it is the largest one available to this project.

## Decision

**Never reverse engineer the commercially-licensed files, by any means, including by passing them
to an LLM.** Never port them to another language or across a process boundary to "avoid" the
licence.

The interface is derived exclusively from Apache-2.0 sources — `packages/ui` (which carries the
complete HTTP contract) and the Apache-2.0 route files (which define the middleware contract).

## Consequences

-   The project can state, truthfully and verifiably, that it never read the licensed files. **The
    absence of reverse engineering is the strongest fact in its favour, and it is spendable exactly
    once.** Reading them even once, even accidentally, even "just to check", destroys it permanently
    and cannot be undone by any later process.
-   Enforcement is mechanical, not aspirational: a pre-commit hook and CI reject modifications to
    the protected paths. Modification is blocked precisely because it implies reading.
-   The prohibition extends to any agent, tool, or model invoked on this repository, and to every
    branch, tag and historical commit — including after the files were deleted.
-   Some work is slower. That cost was accepted deliberately.

## Alternatives considered

-   **Read the files and rewrite them.** Rejected: manufactures a derivative-work argument where
    none currently exists.
-   **Feed them to a separate LLM to summarise or port.** Rejected, and specifically called out
    because it _feels_ like laundering the provenance. It is not — it is reading them with extra
    steps, and it produces exactly the derivative-work exposure the project is avoiding.
-   **Reimplement in another language, or behind a process boundary.** Rejected: copyright protects
    expression, not language choice or process topology. A port of copied logic infringes
    identically. Legitimate as an _architecture_ decision; worthless as a _legal_ one.

## Notes for anyone tempted to re-propose this

It is not unnecessary caution, and the files being deleted does not retire it. The rule exists
because the value being protected — a verifiable record of independent creation — is destroyed by
a single act and cannot be rebuilt. If you believe you have found a variant that avoids this,
write an ADR proposing it and get human sign-off. **Do not act first.**
