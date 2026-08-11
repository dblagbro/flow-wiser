# QA notes

**Last updated: 2026-08-11**

Append-only record of QA runs. Newest first. Findings themselves live in
[`bug-log.md`](bug-log.md); the plan and coverage matrix live in [`testing.md`](testing.md).
This document records **what was run, by whom, against what, and what was not covered**.

Written by the `daily-qa` and `master-qa` skills. Never rewrite an entry — add a new one.

## Entry format

```
## <YYYY-MM-DD> — <daily|master> QA — <candidate>

**Under test:** commit / version / image / deployed where
**Environments:** which instances, and their disposition
**Gates:** lint · build · test · discovery — result each, or NOT RUN with the reason
**Domains covered:** …
**Coverage limits:** what was NOT tested — always stated, never left to silence
**Findings:** IDs, severity, demonstrated vs latent → bug-log
**Artifact levels:** fixed-in-tree / in-image / deployed
**Teardown:** what was removed; production fingerprint unchanged?
**Verdict:** PASS | FAIL | BLOCKED | REVIEW REQUIRED
```

---

## 2026-08-11 — methodology setup pass — no QA executed

**Under test:** `apache2-only` @ `ffae9952`, version `3.1.4-fw10`. Not deployed by this session.

**Gates:** **NOT RUN.** The toolchain cannot execute them — `engines` requires Node `^24` and
pnpm `^10.26.0`; this machine has Node v22.23.2 and no pnpm. `pnpm lint`, `pnpm build`,
`pnpm test` and `scripts/assert-test-discovery.js` were therefore not attempted.

**What was done instead:** static, read-only structural verification during methodology
installation — surface counts, wiring confirmation, control-execution checks. Recorded in
[`current-state.md`](current-state.md) and [`project-map.md`](project-map.md).

**Coverage limits — nothing was functionally tested.** No API, security, UI, ops, data or infra
domain was exercised. No instance was started. Production was not contacted at all.

**Findings:** no functional defects found, because none were looked for. Structural observations
and drift are in [`remediation-plan.md`](remediation-plan.md) as RM-01…RM-10.

**Teardown:** nothing created; nothing to tear down. Production untouched.

**Verdict: BLOCKED** — no QA gate can run until RM-01 (toolchain) is resolved.

> The last full QA run of record is the `3.1.4-fw8-rc2` sweep of 2026-08-09/10, documented in
> [`testing.md`](testing.md) and [`bug-log.md`](bug-log.md). Those results are **three fork
> versions old**; whether each finding remains closed at `fw10` is unverified (RM-08).
