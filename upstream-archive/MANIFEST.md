# Upstream archive snapshot — FlowiseAI/Flowise

Captured: 2026-08-05T13:14:46-04:00
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
