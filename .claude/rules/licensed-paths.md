---
description: Commercially-licensed paths — never read, never edit, deletion only
globs:
    - 'packages/server/src/enterprise/**'
    - 'packages/server/src/IdentityManager.ts'
alwaysApply: true
---

# Licensed paths — hard prohibition

**Never read, open, `cat`, `grep` the contents of, summarise, quote, or pass to any model:**

-   `packages/server/src/enterprise/**`
-   `packages/server/src/IdentityManager.ts`

These carry FlowiseAI's Commercial License. **Deletion is permitted and is the goal. Modification
is not** — editing implies reading, and reading destroys the project's independent-creation record.

The prohibition applies on **every branch, tag, historical commit, stash, worktree and restored
copy** — including `git show <old-sha>:<path>`. It is not retired by the files being absent from
the working tree; at `apache2-only` @ `ffae9952` they are already deleted, and the rule stands.

## Permitted

-   Reporting **whether** such a path exists, by filename only (`ls -d`, `git ls-files`)
-   Deleting them
-   Designing around them from the Apache-2.0 sources: `packages/ui` (the complete HTTP contract)
    and the Apache-2.0 route files (the middleware contract)

## Forbidden — no exceptions

-   Reading them "just to check", "to confirm the interface", or "to be sure the replacement matches"
-   Passing them to another LLM to summarise, port or reimplement — that is reading them with extra
    steps, and it manufactures the derivative-work argument the project exists to avoid
-   Porting them to another language or across a process boundary "to avoid the licence"
-   Restoring them from history to inspect

If a task appears to require reading them, **the task is wrong**. Stop and report.

See [`docs/CLEANROOM-PROTOCOL.md`](../../docs/CLEANROOM-PROTOCOL.md),
[ADR-0001](../../docs/decisions/ADR-0001-clean-room-replacement.md),
[ADR-0002](../../docs/decisions/ADR-0002-no-reverse-engineering.md).
