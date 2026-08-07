#!/usr/bin/env python3
"""Remove diff hunks against commercially licensed paths from the archived patches.

The upstream contribution backlog in `patches/` is a faithful capture of 347 open
pull requests as git-am-able mailboxes. Fifteen of them change files under
`packages/server/src/enterprise/` or `packages/server/src/IdentityManager.ts`,
because that is what those PRs were for -- and a diff hunk carries the
surrounding context lines of the file it patches. Those files were governed by
the FlowiseAI Commercial License, so their content cannot be redistributed, and
keeping the hunks would have made this repository's Apache-2.0 claim false no
matter how thoroughly the files themselves were deleted.

This removes the hunk bodies and nothing else.

  - Decisions are made ONLY on the path in a `diff --git a/… b/…` header. No
    hunk content is inspected, matched on, or read. That is required by
    docs/CLEANROOM-PROTOCOL.md: the point is not merely to avoid copying those
    files but to avoid reading them.
  - The diffstat line naming the file is KEPT, and a marker is left where the
    hunk was, so the archive still records that the pull request touched it and
    how large the change was. A path is not the expression the licence covers,
    and the record is what makes the archive worth having.
  - Every hunk against an Apache-2.0 path is untouched, so the contributed work
    the archive exists to carry forward still applies with `git am`.

Idempotent: re-running finds nothing left to strip.

    python3 upstream-archive/strip-protected-hunks.py --check   # report only
    python3 upstream-archive/strip-protected-hunks.py           # rewrite
"""

import argparse
import pathlib
import re
import sys

PROTECTED = (
    'packages/server/src/enterprise/',
    'packages/server/src/IdentityManager.ts',
)

DIFF_HEADER = re.compile(r'^diff --git a/(\S+) b/(\S+)$')
# A git format-patch mailbox ends each commit with a "-- " signature line, and
# concatenated mailboxes restart with a "From <sha> Mon Sep 17 ..." line.
END_OF_DIFFS = re.compile(r'^(-- $|From [0-9a-f]{7,40} Mon Sep 17 00:00:00 2001$)')
# Diffstat entries look like "  path/to/file.ts | 12 ++++--------"
DIFFSTAT = re.compile(r'^ (\S.*?) +\| +\d+')

MARKER = (
    '[hunk removed by upstream-archive/strip-protected-hunks.py -- this file was '
    'under the FlowiseAI Commercial License and its content cannot be '
    'redistributed. The pull request still changed it; only the diff body is gone.]'
)


def is_protected(path: str) -> bool:
    return any(path.startswith(p) for p in PROTECTED)


def strip(text: str):
    out = []
    removed = []
    dropping = False
    for line in text.splitlines(keepends=True):
        header = DIFF_HEADER.match(line.rstrip('\n'))
        if header:
            a, b = header.group(1), header.group(2)
            dropping = is_protected(a) or is_protected(b)
            if dropping:
                removed.append(a)
                out.append(line)  # keep the header: it is a path, not content
                out.append(MARKER + '\n')
            else:
                out.append(line)
            continue
        if dropping:
            if END_OF_DIFFS.match(line.rstrip('\n')):
                dropping = False
                out.append(line)
            continue
        out.append(line)
    return ''.join(out), removed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true', help='report without rewriting')
    args = ap.parse_args()

    root = pathlib.Path(__file__).resolve().parent / 'patches'
    if not root.is_dir():
        print(f'no such directory: {root}', file=sys.stderr)
        return 2

    touched = 0
    total = 0
    for patch in sorted(root.glob('*.patch')):
        original = patch.read_text(encoding='utf-8', errors='surrogateescape')
        if MARKER in original:
            continue  # already stripped
        stripped, removed = strip(original)
        if not removed:
            continue
        touched += 1
        total += len(removed)
        saved = len(original) - len(stripped)
        print(f'{patch.name}: {len(removed)} protected file diff(s), {saved} bytes removed')
        for path in sorted(set(removed)):
            print(f'    {path}')
        if not args.check:
            patch.write_text(stripped, encoding='utf-8', errors='surrogateescape')

    verb = 'would strip' if args.check else 'stripped'
    print(f'\n{verb} {total} protected file diff(s) across {touched} patch file(s)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
