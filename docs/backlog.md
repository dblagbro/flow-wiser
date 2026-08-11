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

## Operational

### BL-01 · Audit and update outdated nodes in the operator's deployed chatflows

**Raised:** 2026-08-11 by Operator · **Status:** Proposed · **Size:** M · **Value:** Medium

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

**Relationship to BL-02:** this is the manual version of what BL-02 automates. Doing the audit
first is genuinely useful either way — it produces the real-world dataset of version transitions
and parameter changes that BL-02's migration contract has to handle. **Do BL-01's audit before
designing BL-02.**

---

## Done

_(none yet)_
