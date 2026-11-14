# Backlog

**Last updated: 2026-08-11**

Product features and operational tasks that are wanted but not yet scheduled. Distinct from
[`remediation-plan.md`](remediation-plan.md), which tracks defects, drift and risk — this is
work we _choose_ to do, not work that is broken.

Items are `BL-NN`. Newest first within each section.

---

## Product features

### BL-02 · In-product node upgrade — single node and bulk

**Raised:** 2026-08-11 by Operator · **Status:** Proposed · **Size:** L · **Value:** High

Give users a way to upgrade an outdated canvas node **from inside the product**, rather than
deleting and recreating it by hand.

> **Terminology — read first.** "Node" here means a **canvas component** that a user drags onto a
> chatflow, _not_ Node.js. Node.js versioning is a separate concern settled in
> [ADR-0004](decisions/ADR-0004-node-version-conflict.md). The two are unrelated and must never
> be conflated in code, docs, commits or UI copy.

**Current behaviour.** Flowise detects the drift and reports it, then stops. The canvas compares
the version stored on the saved node against the version of the component currently registered:

| Where                                                          | What                                         |
| -------------------------------------------------------------- | -------------------------------------------- |
| `packages/ui/src/views/canvas/CanvasNode.jsx:73–83`            | comparison + warning for standard chatflows  |
| `packages/ui/src/views/agentflowsv2/AgentFlowNode.jsx:185–194` | the same logic, duplicated, for AgentFlow v2 |
| `packages/components/src/Interface.ts:133`                     | `version: number` on the component interface |

```text
if (!data.version)                             -> "Node outdated, update to latest version N"
else if (componentNode.version > data.version) -> "Node version N outdated, update to latest version M"
```

So the warning triangle is **diagnostic only**. There is no upgrade path: the user must delete the
node, add the current one, and re-enter every parameter and re-draw every edge by hand.

**Proposed.**

1. **Single-node upgrade** — right-click the warning triangle (or a button in the node dialog) →
   _Update node_. Show a preview of what will change before applying, and make it undoable.
2. **Bulk upgrade** — "Update all outdated nodes" for a flow, with a summary of what will change
   and which nodes need manual attention.

**The hard part is parameters, not versions.** A version bump can add, remove, rename, retype or
change the default of an input. A naive upgrade that preserves the version number and drops the
parameters produces a node that looks upgraded and does not work. The feature therefore needs:

-   A **migration contract per component version** — the component declares how to map inputs from
    version N to N+1, rather than the UI guessing. Without this, upgrading is unsafe by construction.
-   **Preserve edges and node ID** so surrounding wiring survives.
-   **Classify each upgrade**: fully automatic · automatic with defaults applied (tell the user which)
    · needs manual input (do not silently guess) · not upgradable.
-   **Never silently drop a configured value.** If a parameter has no target, stop and say so.
-   **Credential references must survive.** Flows bind credentials by UUID, and a delete-and-recreate
    has already orphaned 37 references across 21 flows and taken down a live chatbot
    (`PROJECT-LOG.md`). An upgrade that re-creates a node without carrying its credential binding
    would reproduce that outage class exactly.
-   **A version snapshot before any bulk upgrade**, using the existing git-backed versioning
    (`packages/server/src/versioning/`) so a bad bulk run is recoverable. Non-destructive restore is
    already a standing requirement (R5).

**Why it fits the fork's goals.** R2 is _different and better, not a clone_. Upstream shipped the
detection and never the remedy — this is a concrete, user-visible improvement in exactly that gap,
and it builds on versioning infrastructure the project already has.

**Before implementing:** run `master-refactor` planning or the `architect` agent to design the
migration contract. **Do not start with the UI** — the parameter-migration model is the decision
that determines whether this is safe. An ADR is warranted.

**Open questions.**

-   Where does the migration map live — in each component, or a central registry?
-   What happens to a node whose component no longer exists at all?
-   Should bulk upgrade be available from the CLI too, for operators with many flows?
-   The duplicated detection logic in `CanvasNode.jsx` and `AgentFlowNode.jsx` should be unified
    first, or the feature gets built twice and drifts.

---

### BL-03 · Triage the 344 unreviewed upstream contributions

**Raised:** 2026-08-12 by Operator · **Status:** Proposed · **Size:** XL · **Value:** High

`upstream-archive/` preserves **347 open pull requests** from FlowiseAI/Flowise, captured
2026-08-05 before the 2026-08-10 archive lock, as `git am`-able patches with **original authorship
intact**. Only **3** have been acted on. The other **344 have never been reviewed.**

|                      |                                                                                                                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Archived open PRs    | **347** (`pr-814` … `pr-6711`)                                                                                                                                                                                                           |
| Acted on             | **25** — #6682, #6683, #6706, then #6672, #5371, #5255 (pull request #26), #6416, #6635, #6532, #6644, #6143, #6301, #6561, #6725, #6543, #6517, #6601, #6689, #6482 (2026-11-13), #6615, #6353, #6373, #6478, #6491, #6530 (2026-11-14) |
| Never reviewed       | **322**                                                                                                                                                                                                                                  |
| Archived open issues | 698                                                                                                                                                                                                                                      |

`MANIFEST.md` is explicit that the snapshot exists so the backlog stays "reviewable and
**re-appliable**" — captured, not fulfilled. Nothing was lost, but nothing was gained either.

**Why this matters beyond housekeeping.** These are the last contributions the upstream community
will ever make to this codebase — upstream is archived and will accept nothing further. They are
Apache-2.0, they carry their authors' names, and Flow-Wiser exists as a _continuation_ fork. Merging
good work with attribution intact is the most direct expression of that. It is also the cheapest
source of fixes the project will ever have: 129 titles begin `fix`, and someone else already wrote
and tested them.

**Shape of the backlog:**

| Category                     | Count                          |
| ---------------------------- | ------------------------------ |
| `fix` / bug                  | ~129                           |
| `feat` / new node or feature | ~173                           |
| security / CVE-flagged       | 5 (of which 2 already adopted) |
| `chore` / dependency bumps   | ~7                             |
| Drafts (deprioritise)        | 21                             |

Age skews recent — 73 from 2026-06, 56 from 2026-07 — so most were written against a tree close to
the fork point and should still apply cleanly.

**Progress.** The three security PRs first listed here — #6672, #5371, #5255 — were adopted in
pull request #26. #6416 (mass assignment on the execution update endpoint, GHSA-v2cc-6h2j-w847) and
#6635 (telemetry opt-out ignored) and #6532 (a rejected condition branch still ran) were adopted
on 2026-11-13. #6644 (prompt-list fetch timeout), #6143 (`SHOW_COMMUNITY_NODES`
whitespace) and #6301 (chat-message pagination) followed the same day. #6479 was looked at and
skipped: its series is a change followed by its own revert. #6561 (S3 folder markers loaded as files) and #6725
(MCP missing-URL message) were adopted too. So were #6543 (Voyage rerank parsing), #6517 (model-list fetch
timeout), #6601 (Redis metadata escaping) and #6689 (Google Drive loader paging and subfolders). #6482 (UI: guard a missing Axios `error.response`) was adopted in preference to
#6467, which fixes the same thing. #6615 (resolving one human-approval prompt cleared another) was adopted on 2026-11-14, after
confirming that both kinds of pending action carry the node id it matches on and that the resume
request always has one by the time the match runs. #6353 (the Tavily tool passed its API key under a name
the library ignores) was adopted the same day, **first commit only**: the series' second commit
retypes the tool's configuration object and does not compile against the installed
`@langchain/tavily` 1.2.0 (four type errors). The patch shipped no test; one was written here and
shown failing against the unpatched source. #6373 (Bedrock cached a failed inference-profile lookup
for the life of the process) followed, again with a test written here because the patch had none.
Its cost is stated: a region whose lookup keeps failing, or that genuinely has no profiles, is now
asked on every model initialisation instead of once. #6478 (a node's live client was deep-copied before a flow ran,
which broke the OpenAI SDK's private state) was adopted next, all five commits of its series. It
shipped no test; the one written here fails on the unpatched source with the exact error the patch
describes. #6491 (the Document Store vector node did not offer the `VectorStoreRetriever`
type its 22 sibling nodes do) followed, with a test written here. It bumps that canvas node's own
version from 1.0 to 1.1 — the node's version, not the runtime's (BL-02). #6530 (OpenAI embeddings requested as base64 reached the vector
store undecoded) was adopted after confirming in the installed OpenAI SDK that it decodes base64
only when it chose that format itself. Test written here: six of ten cases fail on the unpatched
nodes.

**Examined and not adopted as they stand** — each applies cleanly, but:

-   **#6584** (fail fast on an unsupported Node version) hardcodes a fallback of Node 24 and would be
    a twelfth place declaring the Node version, outside the parity check. It contradicts ADR-0004
    (Node 22) and needs adapting, not applying.
-   **#6596** (Postgres vector store: `ssl` from Additional Configuration overrides the SSL toggle)
    changes what a flow author can do to TLS verification on a connection the server opens. That
    is a security decision, not a bug fix; it needs review against `sanitizeDataSourceOptions`.
-   **#6552 / #6560** (credential kept on a document-store loader update) change credential
    handling and ship no test.
-   **#6136** (GCS uniform-bucket-access env parsing): the fix reads correctly, but its shipped test
    fails to load under this project's Jest setup (`Cannot access 'storageCtorMock' before
initialization`), so it cannot be shown failing before and passing after without rewriting the
    author's test.
-   **#6594** (free-solo dropdown values) changes the two shared dropdown components used across
    the canvas. It ships tests for its helper functions only; the component behaviour needs a
    browser check before it is adopted, and the UI is meant to stay close to upstream.
-   **#6414** (newer Azure OpenAI model names) adds entries to the model list. Whether those models
    are offered on Azure could not be verified from here, so it was left for someone who can check.
-   **#6534** (ChatOpenAI: no retries once a timeout is set) turns off all retries for anyone who
    sets a timeout, including retries after a rate limit or a server error. That is a behaviour
    choice with a cost, not a plain fix; it needs a decision.
-   **#6529** (keep starter prompts on export) widens what a flow export carries to include
    `isPublic`, `apiConfig` and `analytic`. Importing a flow that arrives already marked public is
    a security question, and the patch ships no test.
-   **#6375** (file loaders: detect an overridden file from the upsert API) changes the override
    permission check, treating any `…File` input as covered by the existing `files` permission.
    That list is the control an operator uses to say what an API caller may override, and the patch
    widens it. It needs a security review, and it ships no test.
-   **#6441** (markdown tables in the rich text input) adds a dependency to the UI package, changes
    the lockfile and rewrites how the editor serialises tables. It needs a browser check, and a
    dependency change now has to go through both lines (SEC-DEP-02).
-   **#6472** (ChatOpenAI: read `stop` from base options). In this node the base options are sent
    as HTTP headers; reading a `stop` key out of them as model stop sequences is a new meaning for
    the field, not a clear fix.
-   **#6643** (custom Azure OpenAI model names) rewrites the two shared dropdown components, the
    same ones #6594 touches. Needs a browser check; the two patches should be considered together.
-   **#6669** (accept a variable override at the top level of `overrideConfig`) adds a second way
    to pass variables and decides by name whether a key is a variable or a node input. A
    convenience with a collision question, and it sits in the same override control as #6375.
-   **#6525** (agentflow LLM node: keep token usage when structured output is on) describes a real
    gap and looks sound, but it is five commits across the LLM node and a shared helper, re-attaches
    metadata with `Object.defineProperty`, and ships no test. Worth adopting once a test harness
    for that node exists; not adopted blind.
-   **#6521** and **#6630** no longer apply after the fixes above.

**How a patch is adopted** (the method used for everything above): read the diff for behaviour and
security implications; `git am --keep-non-patch`; run `prettier --check` and `eslint` on the files it
touched, because `git am` bypasses the pre-commit hook; run its test against the patched source and
again with the source reverted, and record both results; credit the author in `CHANGELOG.md`.

**Triage of what remains, 2026-11-13** — every archived patch checked with `git apply --check`
against `apache2-only`:

| Result                                                            | Patches |
| ----------------------------------------------------------------- | ------- |
| Applies cleanly                                                   | 192     |
| Conflicts (needs a manual port)                                   | 140     |
| Touches a licensed path — permanently incomplete, see Constraints | 15      |
| Already in the tree                                               | 3       |

Of the 192 that apply cleanly, 79 are titled as fixes, 93 as features, and 20 are docs, chores or
unlabelled. "Applies" means the diff fits, nothing more: each still needs reading, a test and a
build. The clean-applying fixes that touch one or two files are the cheapest next batch; going by
title alone, the server-side correctness and safety candidates are #6552 and #6560 (credential kept on
document-store loader update), #6478 (do not deep-clone live node
instances) and #6669 (direct variable names in `overrideConfig`).

**Constraints:**

-   **15 of the 347 patches are permanently incomplete.** They touched
    `packages/server/src/enterprise/` or `IdentityManager.ts`, and **196 hunk bodies — 14,224 lines —
    were redacted on 2026-08-06** because diff context carries fragments of commercially licensed
    files. Those cannot be `git am`-ed and **must not be reconstructed**: doing so would mean reading
    licensed content, which is exactly what ADR-0002 forbids. If the underlying need is real,
    re-specify it from Apache-2.0 sources.
-   Apply with `git am --keep-non-patch upstream-archive/patches/pr-<n>.patch` so authorship survives.
    A contribution merged without its author's name is a contribution stolen.
-   Every applied patch needs the same gates as any other change: a test, `pnpm build`, `pnpm test`,
    and a `CHANGELOG.md` entry crediting the author.
-   Expect conflicts against the `apache2-only` line, whose identity layer diverges sharply from what
    these PRs were written against.

**Suggested sequence:** the 3 security PRs → `fix` PRs that still apply cleanly → dependency bumps
(cross-check against `pnpm.overrides` first; the `@anupamme` precedent shows manifest bumps do not
force transitive versions here) → `feat` PRs on merit, since each is new surface to maintain
forever. Drafts last.

**Do not attempt this as one pass.** 344 patches is a programme, not a task. Batch by category,
record progress here, and land them in small reviewable groups.

## Operational

### BL-01 · Audit and update outdated nodes in the operator's deployed chatflows

**Raised:** 2026-08-11 by Operator · **Status:** Audit complete (2026-10-11) — upgrade pending (operator) · **Size:** M · **Value:** Medium

The operator's live deployment shows many canvas nodes carrying "Node version N outdated" warnings
across its chatflows. These should be brought up to current component versions — newer versions
carry fixes and generally perform better.

**This is deployment work, not repository work.** It changes flow definitions in a running
instance's database, not code in this repo.

**Constraints — these are not negotiable:**

-   **Production is read-only** for every agent workflow (`AGENTS.md`). An agent may _audit_ and
    _report_; **applying changes to live flows is an operator action.**
-   Take a **verified backup** of the flow definitions before any change, and confirm it restores.
    A backup that has never been restored is a hypothesis (`backup-plan.md`).
-   **Never delete-and-recreate a node** to upgrade it. Flows bind credentials by UUID; that pattern
    orphaned 37 credential references across 21 flows and took down the public chatbot once already.
-   Change a small number of flows first and verify them end to end before touching the rest.
-   The exposed credential situation in `backup-plan.md` is a separate, higher-priority operator
    action and should not be entangled with this.

**Suggested sequence:**

1. **Audit, read-only** — inventory every flow, node, stored version and current component version;
   produce a table of what is outdated and by how much. This part an agent can do.
2. Group by upgrade risk — trivial bump vs. changed parameters vs. deprecated component.
3. Back up flow definitions; verify the restore.
4. Operator upgrades a pilot flow, tests it live, then proceeds in batches.
5. Record results in `docs/qa-notes.md`.

**Audit result (2026-10-11, step 1 — read-only):** snapshot of the live SQLite DB
(`/root/.flowise/database.sqlite`, 25 chatflows), node `data.version` compared against each
current component's `this.version` in `packages/components/nodes`.

-   **214 node instances across 25 flows; 94 are outdated. Only 2 of the outdated flows are
    `deployed=true`:** the public chatbot `Ask Devin - Public` (3 outdated nodes) and one private
    deployed outdialer flow (3). The other 23 are drafts.
-   **Widest gaps (deployed → current), by reach:** `chatOpenAI` v2→v8.3 (15 flows), `openAIEmbeddings`
    v1→v4 (10), `cheerioWebScraper` v1.1→v2 (12), `conversationalRetrievalQAChain` v1→v3 (12),
    `pdfFile` v1→v2 (8), `llmChain` v1→v3 (5), `chatPromptTemplate` v1→v2 (5), `docxFile` v1→v2 (4),
    `chatAnthropic` v7→v8 (4), `chatOllama` v2→v5 (2), `chatGoogleVertexAI` v2→v5.3 (1).
-   **3 node types in flows have no matching `name` in current components** (renamed or removed —
    these are the delete-and-recreate landmines from the constraints above, _not_ simple bumps):
    `faissUpsert` (2), `faissExistingIndex` (1), `ElasticsearchIndex` (1).
-   **Next step is an operator action:** back up flow definitions and verify the restore, then upgrade
    the 2 deployed flows first (6 nodes total), test live, then batch the drafts. The 3 renamed/removed
    types need manual re-wiring that preserves credential UUIDs — never delete-and-recreate.
-   Full machine-readable report retained for this session at `scratchpad/bl01-report.json`.

**Relationship to BL-02:** this is the manual version of what BL-02 automates. Doing the audit
first is genuinely useful either way — it produces the real-world dataset of version transitions
and parameter changes that BL-02's migration contract has to handle. **Do BL-01's audit before
designing BL-02.** The audit above now gives BL-02 its real transition set — including the three
renamed/removed types, which are the cases its migration contract most has to get right.

---

## Done

_(none yet)_
