# Market review

**Last updated: 2026-08-11** · **Status: NOT YET CONDUCTED**

Competitive, open-source, licensing and demand research. Maintained by the `market-review` skill,
which uses the `market-analyst` agent.

## As of

**No market research has been conducted for this project yet.** This document is the structure and
the method; it holds no findings. Do not cite it as evidence of a market position — its current
content is a plan, not a result.

The background in [`PROJECT-LOG.md`](PROJECT-LOG.md) and [`product.md`](product.md) is _project_
history, not market research: it records upstream's end-of-life and this fork's response, not a
survey of the landscape.

## Disclosure rule — binding

**A web search is a publication.** Research on this project never sends outside this machine:

-   repository code, internal documentation, or file contents
-   unreleased or unfixed security findings, or anything from `docs/security/`, `bug-log.md`,
    `ISSUE-REGISTER.md`
-   infrastructure details, hostnames, IP addresses, container names
-   any secret, token or credential

Search with generic public terms only. Never post, comment, file an issue or open a PR anywhere.

## Method

-   **Date everything.** Every claim carries an absolute date, a source URL, and the date searched.
    Undated market claims rot invisibly and are worse than no claim at all.
-   Prefer **primary sources** — the repository, the registry, the licence file, the official
    announcement. Check dates: an archived project's "latest" may be long stale.
-   Label every claim **verified** (primary source), **reported** (secondary), or **inference**.
    Never let inference read as fact.
-   Quantify where possible; write "unknown" where not. Do not manufacture precision.
-   Report findings that argue **against** current direction as prominently as supporting ones.
-   Describe what licences say; **give no legal advice**. Counsel reviews anything consequential.

## Areas to cover

| Area                        | Questions                                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Forks and continuations** | Who else forked Flowise after the 2026-08-03 EOL announcement? Activity, licensing stance, do they address the commercially-licensed subsystem? |
| **Alternatives**            | Comparable visual LLM-flow/agent builders; licences, momentum, where they are genuinely better                                                  |
| **Licensing landscape**     | Relicensing and source-available trends; what they mean for an Apache-2.0-only positioning                                                      |
| **Demand signals**          | Issues, discussions, downloads, image pulls; what users actually ask for; signal vs noise                                                       |
| **Upstream state**          | Archive status since 2026-08-10, advisory flow, whether anything moved                                                                          |

## Findings

_(none — see Status above)_

## Implications for Flow-Wiser

_(pending research)_

## Unknowns

Everything in Areas to cover. Specifically unestablished, and worth knowing early:

1. Whether another fork is pursuing the same Apache-2.0 replacement of the auth/RBAC subsystem —
   which would make duplicated effort, or collaboration, a live question.
2. Whether demand for enforced RBAC, SSO and MFA in this category is real or assumed.
3. Whether upstream's archival changed after 2026-08-10.

## History

| Date       | Reviewer | Summary                                                               |
| ---------- | -------- | --------------------------------------------------------------------- |
| 2026-08-11 | —        | Document created during methodology setup. **No research conducted.** |

> When the first real review runs, it replaces the Findings, Implications and Unknowns sections
> and appends a row here. This History table is append-only.
