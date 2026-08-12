---
name: market-review
description: Dated competitive, open-source, licensing and demand research on the Flowise fork landscape and alternatives. Every claim carries a source and a date. Read-only externally — it never posts, files issues, or sends repository content anywhere.
---

# market-review

Understand the outside world, with sources and dates. Research is not advocacy: report findings
that undercut the project's premise as readily as ones that support it.

## 1. The disclosure rule — read first

**A web search is a publication.** Never send outside this machine:

-   repository code, internal documentation, or file contents
-   unreleased or unfixed security findings
-   defect details, infrastructure details, hostnames, IP addresses, container names
-   anything from `docs/security/`, `docs/bug-log.md` or `docs/ISSUE-REGISTER.md`
-   any secret, token or credential

Search with **generic public terms only** ("Flowise fork", "Apache-2.0 LLM flow builder"), never
with a string taken from this repository.

Never post, comment, file an issue, open a PR, or write to any external system. Read-only.

## 2. Orient

Read `docs/product.md`, `docs/market-review.md` (extend the record; do not restate it),
`docs/PROJECT-LOG.md`, `FORK.md`.

Use the **market-analyst** agent if `.claude/agents/market-analyst.md` exists; otherwise work
inline to the same standard.

## 3. Research

Cover, for a full review:

| Area                        | Questions                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Forks and continuations** | Who else forked upstream? Activity, licensing stance, are they solving the same commercially-licensed-subsystem problem? |
| **Alternatives**            | Comparable projects, their licences, momentum, and where they are genuinely better                                       |
| **Licensing landscape**     | Relicensing moves, source-available trends, what it means for an Apache-2.0-only positioning                             |
| **Demand signals**          | Issues, discussions, downloads, image pulls — what users actually ask for; separate signal from noise                    |
| **Upstream state**          | Archive status, advisory flow, whether anything moved since the freeze                                                   |

Method:

-   **Date everything.** Every claim gets an absolute date and a source URL, plus the date you
    searched. Undated market claims rot invisibly.
-   Prefer **primary sources** — the repository, the registry, the licence file, the official
    announcement. Check dates; an archived project's "latest" may be long stale.
-   Label each claim: **verified** (primary source), **reported** (secondary), or **inference**.
    Never let inference read as fact.
-   Quantify where you can; write "unknown" where you cannot. Do not manufacture precision.
-   You may report what licences say. **You may not give legal advice** — state plainly that
    counsel must review anything consequential.

## 4. Record

Write `docs/market-review.md`: replace the previous _findings_, preserve the history section so
the record accumulates. Structure: **As of** (search date) · **Summary** (what changed) ·
**Findings** (by area, each with source URL, source date, confidence) · **Implications for
Flow-Wiser** (including what argues _against_ current plans) · **Unknowns** (and what would
resolve them).

If a finding should change project direction, propose an ADR in `docs/decisions/` — propose,
do not decide.

## 5. Stop before

Any external write. Any licensing conclusion presented as settled. Any strategic decision — you
inform it, a human makes it.

## 6. Report

```
MARKET REVIEW — as of <date searched>
Summary     <what changed since last review>
Findings    <n>  (verified <n> · reported <n> · inference <n>)
Notable     <top 3, one line each, with source date>
Counter     <findings that argue against current direction>
Unknowns    <what could not be established>
Doc         docs/market-review.md updated

STATUS: REVIEW COMPLETE | BLOCKED — <need>
```
