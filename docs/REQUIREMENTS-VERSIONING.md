# Requirements — Flow & Prompt Versioning

Net-new capability. Upstream Flowise never had it. **No licensing entanglement** — this
touches no commercially-licensed path and ships independently of the auth rewrite.

## Problem

Editing a flow overwrites it. There is no history, no diff, no restore. A prompt tweak
that degrades answers is unrecoverable unless someone happened to take a database backup.
Real prompts here run to **11,649 characters** in a single node — losing an iteration is
expensive.

## Objective

Return to any prior state of any flow or prompt, see exactly what changed between two
points in time, and restore **without destroying** the version being moved away from.

## Design: git as the version store

`flowData` averages **331 KB** and peaks at **5.9 MB**. Snapshotting every save into a
table would balloon storage — 100 saves of the largest flow is ~590 MB. Git's delta
compression makes this roughly an order of magnitude smaller, and gives history,
branching, diffing and restore as solved problems rather than code we have to get right.

**Library:** [`isomorphic-git`](https://github.com/isomorphic-git/isomorphic-git) — MIT,
pure JavaScript, no native dependencies. Important on Alpine, where native builds are a
known failure mode in this project (`better-sqlite3` under node-gyp on Node 24).

### Layout

```
<data-dir>/versions/            git repository
  flows/<chatflowId>.json       one file per flow
  meta/<chatflowId>.json        name, type, deployed, category
```

### Normalisation — the detail that makes prompt diffs work

Flowise stores `flowData` **minified**: one enormous line. A diff of that is unreadable.

Before committing, serialise with **`indent=2` and sorted keys**. Deterministic,
line-oriented output means editing one system prompt produces a diff of exactly the
changed lines — turning this from "restore an opaque blob" into "see what changed in this
prompt, and when".

This single choice is what makes prompt-level versioning real.

### Commit metadata

- Author: the acting user
- Timestamp: real edit time
- Message: auto-generated summary (`Update Ask Devin — chatPromptTemplate.systemMessagePrompt`)
- Optional user-supplied label for named checkpoints

## Restore semantics — non-destructive by construction

```
v1 → v2 → v3 → v4        currently on v4, it is wrong
              ↘ v5       restore v2  →  commits v5 with v2's content
                          v3 and v4 remain in history, permanently
```

**Restore never rewrites history.** It writes a new commit whose content equals the
chosen earlier version. The abandoned line stays fully recoverable — return to v4
tomorrow, diff v2 against v4, or branch from either. This is inherent to git, not
behaviour we hand-build.

## Functional requirements

1. **Automatic capture** — every flow create/update commits. No user action.
2. **History** — per flow: timestamp, author, message, changed nodes.
3. **Point-in-time** — "show this flow as of <date>".
4. **Diff** — any two versions, prompt changes legible as text.
5. **Restore** — one click, non-destructive per above.
6. **Named checkpoints** — tag a version ("before RAG prompt rewrite").
7. **Prompt-focused view** — filter the diff to prompt/template fields only.
8. **Export** — a version as JSON, for import elsewhere.
9. **Retention** — configurable; `git gc` for housekeeping.

## Phases

**Phase 1 — capture (independent of any UI work)**
A watcher committing every flow change. Delivers history, point-in-time restore and
diffs via CLI immediately. Value: **history starts accumulating now** rather than
whenever the UI ships. Every edit made before Phase 2 is captured, not lost.

**Phase 2 — UI, ~800 LOC, all Apache 2.0**
- Version history side drawer — follow the existing Apache-2.0
  `packages/ui/src/views/evaluations/EvaluationResultVersionsSideDrawer.jsx` pattern
- Diff view with prompt highlighting
- Restore + named checkpoints
- Server: `GET /flow-versions/:id`, `GET /flow-versions/:id/:ref`,
  `GET /flow-versions/:id/diff?a=&b=`, `POST /flow-versions/:id/restore`

## Non-goals

- Not a replacement for database backups — this versions flow definitions, not chat
  history, credentials or execution state.
- No merge/conflict resolution in v1. Last write wins, with full history to recover from.

## Acceptance

1. Every flow edit produces a commit with correct author and timestamp.
2. A prompt change shows as a legible line-level diff.
3. Restoring an older version leaves the newer version fully recoverable.
4. Storage growth materially below full-snapshot equivalent.
5. Restore round-trips: restored flow is byte-identical to the version selected.
6. No dependency on any commercially-licensed path.
