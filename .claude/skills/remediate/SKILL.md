---
name: remediate
description: Work through known defects, risks and drift from the bug log, issue register and remediation plan — fix, verify, and close each one with evidence. Use after a QA sweep or when clearing a backlog of known problems.
---

# remediate

Close known problems properly. The failure mode this guards against is a defect marked FIXED on
the strength of a code change nobody exercised.

## 1. Orient

Read `AGENTS.md`, `docs/bug-log.md`, `docs/ISSUE-REGISTER.md`, `docs/remediation-plan.md`,
`docs/PROCESS-GAPS.md`, and `docs/security/` if security findings are in scope.

```bash
cd /mnt/s/code/flow-wiser
git status --porcelain && git rev-parse --abbrev-ref HEAD && git log --oneline -5
```

Clean tree required. If dirty with work you did not create, stop and report — never stash.

## 2. Build the work list

Collect open items across all three registers, deduplicate, and order by **demonstrated**
severity: blocking → high → medium → low. Note which are latent rather than active.

Present the ordered list before starting. If any item requires a product, security, licensing or
production decision, mark it **REVIEW REQUIRED** and leave it for a human — do not decide it.

## 3. Fix each item

Per item, using the **implementer** agent (or **debugger** if the cause is not established, or
**security-reviewer** to re-verify a security finding) — check the agent file exists first:

1. **Reproduce first.** If you cannot reproduce it, do not "fix" it — reclassify it as
   unreproducible with the conditions you ruled out. A fix for a defect you never observed is a
   guess that closes a ticket.
2. Write the failing test. Security findings get a **negative** test reproducing the original
   exploit condition exactly.
3. Make the minimal change.
4. Show the test now passes, and that the reproduction no longer reproduces.
5. **Fix the layer, not just the instance.** If the same defect class can recur, add the
   deterministic control — test, hook, CI check, lint rule — or an ADR. Per `AGENTS.md §12`.

One item per commit. Never batch unrelated fixes.

## 4. Verify the whole

```bash
pnpm lint && pnpm build && pnpm test
node scripts/assert-test-discovery.js
```

If the toolchain cannot run, report `BLOCKED` and mark every item as **fix written, unverified**.
Never move an item to FIXED without verification.

## 5. Status vocabulary — use it precisely

| Status          | Means                                                  |
| --------------- | ------------------------------------------------------ |
| FIXED IN TREE   | code changed, test passes                              |
| FIXED IN IMAGE  | present in a built artifact                            |
| DEPLOYED        | live where it matters                                  |
| PARTIAL         | mitigated, with the residue named                      |
| UNREPRODUCIBLE  | could not be demonstrated; conditions ruled out listed |
| REVIEW REQUIRED | needs a human decision                                 |

A finding is only closed at the level you actually verified. Never write FIXED when you mean
FIXED IN TREE — this project has been burned by exactly that gap, with a live disclosure open in
production while the tree said fixed.

## 6. Record

Update `docs/bug-log.md` and `docs/ISSUE-REGISTER.md` with the precise status and its evidence.
Update `docs/remediation-plan.md` — remove what is closed, add what you discovered. Append to
`CHANGELOG.md` where user-visible. Add process failures to `docs/PROCESS-GAPS.md` with the
control that will prevent recurrence.

## 7. Stop before

Pushing, publishing, deploying, rotating live credentials, destructive database actions, or
weakening any guard to make a check pass. Redeploy and rotation are **operator actions** —
recommend them; never perform them. See `AGENTS.md §11`.

## 8. Report

```
REMEDIATE — <date>
Worklist   <n> items (<n> blocking)
Closed     <ID · status · evidence, one line each>
Deferred   <ID · why · who decides>
Prevention <controls added, and whether each was observed to work>
Verified   <commands + real result, or NOT RUN — why>

STATUS: PASS | FAIL — <n> unresolved | BLOCKED — <need> | REVIEW REQUIRED — <decision>
```
