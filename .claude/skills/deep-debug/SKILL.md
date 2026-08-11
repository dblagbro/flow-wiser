---
name: deep-debug
description: Chase a hard bug to a proven root cause — intermittent, environment-dependent, or where an earlier fix did not hold. Produces a demonstrated cause with a reversible proof, not a plausible theory. Use when the obvious explanation has already failed.
---

# deep-debug

For defects where the obvious answer was wrong. The output is a **proven** cause or an honest
"not established" — never a confident guess.

## 1. Orient

Read `AGENTS.md`, `docs/bug-log.md`, `docs/PROJECT-LOG.md` (its Lessons section records the
failure shapes this codebase actually produces), `docs/PROCESS-GAPS.md`, and `docs/testing.md`
for environment discipline.

```bash
cd /mnt/s/code/flow-wiser
git rev-parse --abbrev-ref HEAD && git rev-parse --short HEAD && git status --porcelain
git log --oneline -15
```

Use the **debugger** agent if `.claude/agents/debugger.md` exists; otherwise work inline to the
same standard.

## 2. Reproduce before theorising

Get a deterministic reproduction first. If you cannot reproduce it, that is a real result — report
it with the conditions you ruled out, and stop rather than fixing something you never observed.

**Never reproduce against production.** Disposable instance, own volume, GET-only against prod if
you must compare. Never `docker compose down` or remove volumes.

## 3. Read the actual evidence

The verbatim error, stack, exit code, HTTP status, query, log line. Not what the code appears to
do. Reading code to form a theory before reading the evidence is how the wrong cause gets fixed.

## 4. Treat the environment as a suspect

This project's hardest bugs were environmental, not logical. Check specifically:

-   **Dependency resolution of the final tree**, not the manifest's intent. An unpinned transitive
    dependency made "3.1.3 works, 3.1.4 is broken" — where the real variable was _when the image
    was built_, not which version it claimed.
-   **A later step reverting an earlier one.** Per-step assertions cannot catch this; a pin applied
    in one `RUN` and reverted by a later `npm install` still prints success. Assert final state.
-   **Docker layer cache keys.** If the command text never changes, the layer never rebuilds.
-   **Single-file bind mounts bind the inode.** `sed -i` writes a new file and renames, silently
    severing the mount. Verify with `stat -c %i` on both sides.
-   **Content-hashed assets.** Any mount keyed to a built filename stops applying after a rebuild.
-   Node version, container build date, environment variables, caches.

## 5. Bisect

Narrow by layer (route → middleware → service → data), by input, by version, by environment.
`git log`, `git bisect` and diffing a working against a broken artifact are all legitimate.

## 6. Prove it by toggling

Change the one thing your cause predicts; show the behaviour flips. Revert it; show it flips back.

**A cause you cannot toggle is a hypothesis.** Label it as one. Confidence is either
`CONFIRMED (toggled)` or `HYPOTHESIS`, and you must not blur them.

## 7. Distinguish trigger from cause

The commit that surfaced a defect is frequently not the one that introduced it. Say which is
which; fixing the trigger leaves the cause in place.

## 8. Fix and prevent

-   Minimal change addressing the **cause**.
-   A regression test that fails before and passes after; a negative test for anything security-related.
-   Then fix the layer: which control should have caught this — a test, a hook, CI, a lint rule, an
    ADR? Add it, and **verify it fires on a known-bad input and passes on a known-good one**.
    Per `AGENTS.md §12`.
-   Remove your instrumentation, and list anything you left behind.

## 9. Record

`docs/bug-log.md` (finding + status), `docs/PROJECT-LOG.md` (if it revealed a new failure shape
worth recording as a lesson), `docs/PROCESS-GAPS.md` (if a control should have caught it).

## 10. Stop before

Pushing, publishing, deploying, restarting production, destructive database actions.

## 11. Report

```
DEEP DEBUG — <date>
Symptom     <verbatim>
Reproduced  <steps + environment>  |  NOT REPRODUCED — <conditions ruled out>
Trigger     <what surfaced it>
Root cause  <mechanism, path:line>
Proof       toggled off -> <result>; toggled back -> <result>
Confidence  CONFIRMED | HYPOTHESIS — <what would prove it>
Fix         <change + regression test>
Prevention  <control added + evidence it fires on known-bad and passes on known-good>
Left behind <instrumentation, or none>

STATUS: ROOT CAUSE CONFIRMED | HYPOTHESIS ONLY | BLOCKED — <need> | REVIEW REQUIRED — <decision>
```
