# ADR-0003 — Adopt the agentic development methodology

**Status:** Accepted
**Date:** 2026-08-11
**Decided by:** Operator

## Context

Most of this project's work is done by AI agents across many sessions. Two failure modes had
already been paid for and documented in [`PROCESS-GAPS.md`](../PROCESS-GAPS.md):

-   **G1 — controls that were written and documented but never observed to execute.** The
    clean-room guard was inert: `core.hooksPath` was unset, so the hook never ran in a fresh clone —
    which is how every delegated agent worked — while `Proprietary Path Guard` was gated
    `if: github.repository == 'FlowiseAI/Flowise'` and skipped 57 of 57 runs. Their existence was
    taken as evidence of their operation. The most serious defect of the project went undetected
    while documentation asserted a guard was preventing exactly that.
-   **A large share of one session's effort spent repairing defects introduced earlier in that same
    session**, and one incorrect licensing claim published three times.

Conventions recorded only in prose are conventions an agent may or may not read. The rules that
matter here — never read the licensed paths, production is read-only, never push or publish, a fix
in the tree is not a fix in production — are exactly the rules that are expensive to forget once.

## Decision

Adopt a standardized agentic methodology in the repository:

-   **`AGENTS.md`** — the portable, tool-agnostic project contract. **`CLAUDE.md`** begins with
    `@AGENTS.md` and adds only Claude-specific environment notes.
-   **`.claude/agents/`** — nine project subagents with least-privilege tools: `cartographer`,
    `architect`, `implementer`, `debugger`, `qa-engineer`, `security-reviewer`, `release-engineer`,
    `platform-engineer`, `market-analyst`. None has remote-mutation authority.
-   **`.claude/skills/`** — eleven workflow skills invoked by intent. **The human never names an
    agent**; skills select agents internally and fall back to built-in capability when one is absent.
-   **`docs/index.md`** — an authority map declaring which document owns which topic, and marking
    known drift explicitly rather than letting stale documents read as current.
-   **`.claude/rules/`** — path-scoped rules for the highest-risk directories.
-   **Deterministic enforcement** — secret patterns in `.gitignore`, plus CI and hooks that are only
    enabled once verified.

Two rules bind the methodology itself:

1. **Existence is not enforcement.** A control is not in place until it has been observed
   _failing on a known-bad input_ and _passing on a known-good one_, in the environment that runs
   it. Both halves. This is why the secret-scanning workflow ships `.disabled` — the scanners are
   not installed on this machine, so it cannot be verified, so it is not enabled.
2. **Every workflow ends in an explicit verdict** — PASS, FAIL, BLOCKED or REVIEW REQUIRED. An
   unrun gate reports BLOCKED. It never reports PASS.

## Consequences

-   Rules that were prose become instructions agents actually receive, and — where they can be made
    deterministic — checks that do not depend on an agent remembering.
-   Prohibited actions (push, publish, deploy, destructive database operations, production changes,
    weakening a guard to make a check pass) are stated in every relevant agent and skill, not in one
    document someone may not have read.
-   Documentation drift becomes visible rather than silent: `docs/index.md` names stale documents,
    and `remediation-plan.md` tracks them as work.
-   **Restart required** — `.claude/agents/` did not exist when the installing session started, so
    the agents are not discoverable until Claude Code restarts. Skills registered immediately.
-   Ongoing cost: the maps, logs and registers must be maintained, or they become the next
    generation of stale documents. `AGENTS.md §7` assigns that maintenance to each change.

## Alternatives considered

-   **Keep conventions in prose only.** Rejected: it is what produced G1. Documentation cannot
    enforce itself, and an agent that does not read it is unconstrained by it.
-   **Rely on CI alone.** Rejected: CI catches problems after the work is done, and G1 was a case of
    CI itself being structurally incapable of running. Guidance and enforcement are both needed, and
    neither substitutes for the other.
-   **Let the human invoke individual subagents by name.** Rejected explicitly by the operator: the
    interface is the workflow, not the agent roster. Agents are an implementation detail.
-   **Install blocking hooks immediately.** Rejected: an unverified gate is the G1 failure mode
    wearing a different hat. Hooks are enabled only after both halves of the verification.
