# Upstream archive snapshot — FlowiseAI/Flowise

> **Refreshed 2026-08-12 — and the reason for this archive did not hold.**
> Upstream was **not** archived on 2026-08-10: the repository reports `archived: false`,
> comments still work, and **three pull requests were merged on 2026-08-07**. It is frozen,
> not closed. See [`DELTA-2026-08-12.md`](DELTA-2026-08-12.md) for the delta, the three
> merged fixes this fork is missing, and the open upstream PRs Flow-Wiser has already solved.

Captured: 2026-08-05T13:14:46-04:00 · Refreshed: 2026-08-12
Reason: upstream repository moves to public archive on 2026-08-10, which locks
issues and pull requests. This snapshot preserves the open contribution backlog
so it remains reviewable and re-appliable in flow-wiser.

| Item | Count |
| --- | --- |
| Open pull requests | 347 |
| Open issues | 698 |

## Layout

- `prs/index.json` — flat PR index (number, author, title, head repo/ref/sha)
- `prs/_all-open-prs.json` — raw upstream API payloads
- `prs/pr-<n>-files.json` — files touched per PR
- `patches/pr-<n>.patch` — git-am-able mailbox patch, **preserves original author**
- `issues/open-issues.json` — open issues (PRs excluded)
- `issues/security-issues.json` — security/vulnerability/CVE-labeled issues

## Applying a patch with author attribution intact

```bash
git am --keep-non-patch upstream-archive/patches/pr-6706.patch
```

Contributions remain the work of their original authors under Apache 2.0.

## Redacted: diff hunks against commercially licensed paths

**2026-08-06.** Fifteen of the 347 patches changed files under
`packages/server/src/enterprise/` or `packages/server/src/IdentityManager.ts` —
that is what those pull requests were for. A diff hunk carries the surrounding
context lines of the file it patches, so those patches contained fragments of
files governed by the FlowiseAI Commercial License, which forbids
redistribution. They were also being copied into every container image built
from this repository.

**196 hunk bodies across 15 patches — 14,224 lines — have been removed** by
[`strip-protected-hunks.py`](strip-protected-hunks.py), which is committed here
so the operation is reproducible and auditable:

```bash
python3 upstream-archive/strip-protected-hunks.py --check   # reports, changes nothing
```

What was kept and why:

- The `diff --git` header and the diffstat entry naming each file **stay**, with
  a marker where the hunk was. The archive still records that the pull request
  touched that file and how large the change was. A path is not the expression
  the licence covers, and that record is most of what makes this archive worth
  having.
- **Every hunk against an Apache-2.0 path is untouched.** The contributed work
  this archive exists to carry forward still applies with `git am`.
- Decisions were made **only** on the path in a `diff --git a/… b/…` header. No
  hunk content was inspected or matched on, as `docs/CLEANROOM-PROTOCOL.md`
  requires.

Consequences, stated plainly:

- These 15 patches are **no longer faithful captures** of their pull requests.
  Anyone wanting the full original must fetch it from upstream, where it is
  still published under the terms that apply to it.
- A patch whose *only* changes were to a protected file — `pr-6706` is one, and
  it is the `connect-sqlite3` fix by **PiedPiper911** — now applies nothing.
  That is not a loss in practice: the file it patched does not exist in this
  fork, so it could never have been applied here. The defect it fixes is
  addressed independently; see `CHANGELOG.md`.

`upstream-archive/` is excluded from container images via `.dockerignore`, and
the root `Dockerfile` fails the build if it appears in one anyway.
