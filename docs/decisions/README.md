# Architecture decision records

One file per significant decision: `ADR-NNNN-kebab-case-title.md`.

**Point-in-time records — never rewrite one.** If a decision changes, write a new ADR that
supersedes it and update the old one's Status line to `Superseded by ADR-NNNN`. The record of
having decided otherwise is the point.

## When an ADR is required

-   Changing module boundaries or the dependency direction
-   Adding a top-level directory
-   Persistence or topology decisions (for example, requiring Postgres before horizontal scaling)
-   Anything affecting the clean-room position or licensing
-   Rejecting an approach in a way that should stop it being re-proposed
-   Any decision a future contributor would otherwise reasonably reverse

## Template

```markdown
# ADR-NNNN — <title>

**Status:** Proposed | Accepted | Superseded by ADR-NNNN | Rejected
**Date:** YYYY-MM-DD
**Decided by:** <human>

## Context

What forced a decision. Facts, with evidence.

## Decision

What was decided, in the active voice.

## Consequences

What becomes true, easier, harder, or impossible.

## Alternatives considered

Each with the reason it was not chosen.
```

## Index

| ADR                                        | Title                                            | Status                       |
| ------------------------------------------ | ------------------------------------------------ | ---------------------------- |
| [0001](ADR-0001-clean-room-replacement.md) | Clean-room replacement of the licensed subsystem | Accepted                     |
| [0002](ADR-0002-no-reverse-engineering.md) | No reverse engineering, including via an LLM     | Accepted                     |
| [0003](ADR-0003-agentic-methodology.md)    | Adopt the agentic development methodology        | Accepted                     |
| [0004](ADR-0004-node-version-conflict.md)  | Node version conflict                            | **Proposed — needs a human** |
