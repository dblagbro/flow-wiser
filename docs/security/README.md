# Security documentation

Flow-Wiser is a continuation of Flowise, whose maintainers ended the project on 2026-08-03 and
archived the repository on 2026-08-10. Upstream will not receive another security patch.

This directory is the public record of what that inheritance contained and what was done about it.

| Document                                                             | Audience                      | What it is                                                         |
| -------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------ |
| [REMEDIATION-BRIEF-EXECUTIVE.md](REMEDIATION-BRIEF-EXECUTIVE.md)     | Leadership, procurement, risk | What was wrong, in plain terms, and what it meant in practice      |
| [REMEDIATION-BRIEF-ENGINEERING.md](REMEDIATION-BRIEF-ENGINEERING.md) | Engineers, security reviewers | Root cause, the patch, the file, and how to reproduce each finding |
| [../ADVISORY-SWEEP.md](../ADVISORY-SWEEP.md)                         | Anyone auditing the claim     | All 116 upstream advisories, each individually dispositioned       |
| [../PROCESS-GAPS.md](../PROCESS-GAPS.md)                             | Maintainers                   | How each class of defect got past us, and the control added        |

## The claim, stated precisely

The claim is **not** "this software has no vulnerabilities" — nobody can honestly say that about any
software. It is narrower, and checkable:

> Every publicly known vulnerability in this codebase's lineage has been examined individually
> against current code; the results are published, including the ones that reflect badly on us; and
> the four that were still live have been fixed and verified in production.

## What is still open

Deliberately listed, because a security document containing only good news is not evidence.

-   **`vm2` is still the default code-execution sandbox.** It is deprecated upstream, by its own author,
    on the grounds that its escapes could not be reliably closed. Our configuration defeats all four
    published escape techniques — but that is configuration, not architecture.
    `CODE_EXECUTION_MODE=disabled` removes the capability entirely and is the correct setting for any
    deployment not using code blocks. It is not the default because flipping it would silently break
    existing workflows; that is an operator's decision, and these documents exist so it can be an
    informed one.
-   Lower-severity items are tracked in the public issue register.

## Reporting a vulnerability

Open a [security advisory](https://github.com/dblagbro/flow-wiser/security/advisories/new) rather
than a public issue. We would rather hear it from you than read it in an advisory later.
