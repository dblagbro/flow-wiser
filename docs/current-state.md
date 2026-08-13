# Current state

**Last updated: 2026-08-11** · **Observed at:** `apache2-only` @ `ffae9952`

What is verifiably true in the tree right now. Every line here was observed, not inferred from
another document. For the public-facing narrative see [`STATUS.md`](STATUS.md) — **which is
currently stale and contradicts this document** (see Drift below).

## Branches

| Branch         | Role                        | Notes                                  |
| -------------- | --------------------------- | -------------------------------------- |
| `main`         | patched, deployable Flowise | the line to deploy                     |
| `apache2-only` | Apache-2.0 continuation     | current working baseline; `3.1.4-fw10` |

Remote also carries `fix/*` and `ops/*` branches. The `wip/*` branches (`unbrick`,
`versioning-ui`, `release`) **no longer exist on the remote** — see [`backup-plan.md`](backup-plan.md).

## Observed at `ffae9952`

| Observation                                                 | Method                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Version is `3.1.4-fw10`                                     | `jq -r .version package.json`                                                               |
| `packages/server/src/enterprise/` **does not exist**        | `ls -d` (directory listing only — never read)                                               |
| `packages/server/src/IdentityManager.ts` **does not exist** | `ls`                                                                                        |
| Apache-2.0 `identity/` layer present                        | `rbac/`, `tenancy/`, `crypto/`, `middleware/`, `routes/`, `services/`, `PlatformManager.ts` |
| Identity routes **are mounted**                             | `routes/index.ts:64–72` imports and mounts six routers                                      |
| Identity entities **are registered**                        | `database/entities/index.ts:39`                                                             |
| No residual "Commercial License" markers in `.ts`           | `grep -rl` returned nothing                                                                 |
| Tags through `v3.1.4-fw10` exist on the remote              | `git ls-remote --tags`                                                                      |

**What this does and does not mean.** The commercially-licensed subsystem is absent from this
branch and a wired Apache-2.0 replacement is in its place. That is a structural observation.

It is **not** a licensing determination. A license claim requires a full provenance audit and
human sign-off — see [`CLEANROOM-ATTESTATION.md`](CLEANROOM-ATTESTATION.md) and
[`COMPLIANCE-POSTURE.md`](COMPLIANCE-POSTURE.md). An incorrect licensing claim has been published
three times on this project (`PROCESS-GAPS.md`), so no agent asserts one as a side effect of
other work. **REVIEW REQUIRED — a human must decide and state the licensing position.**

## Structure

62 route groups · 6 identity route files · 23 entity files · 53/55/57/56 migrations
(sqlite/postgres/mysql/mariadb) · 49 controllers · 43 services · 29 UI view directories ·
156 test files · 11 workflows · **0** Kubernetes/IaC manifests.

Detail in [`project-map.md`](project-map.md).

## Toolchain

|      | Required                                 | Present         |
| ---- | ---------------------------------------- | --------------- |
| Node | `^22` (`engines`), `v22.23.2` (`.nvmrc`) | **v22.23.2** ✅ |
| pnpm | `^10.26.0`                               | **10.26.0** ✅  |

Resolved 2026-08-11. The project standardised on **Node 22** —
[ADR-0004](decisions/ADR-0004-node-version-conflict.md), Accepted — and eleven locations that
carried five different Node values were aligned to it. pnpm was provisioned via corepack.

`~/.local/bin` must be on `PATH`, or the toolchain appears missing in a new shell:

```bash
corepack enable --install-directory ~/.local/bin   # plain `corepack enable` needs root
export PATH=~/.local/bin:$PATH
```

**Build, lint and test can now run.** Whether they _pass_ on Node 22 is recorded in
[`testing.md`](testing.md) — a Node major bump is exactly the change that compiles and then fails
at runtime, so images must be booted, not just built (RM-12).

## Controls — existence vs. execution

| Control                                        | State                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------- |
| `.githooks/pre-commit` (clean-room guard)      | ✅ **ACTIVE — both halves verified 2026-08-11**                                 |
| Claude advisory path guard (`.claude/hooks/`)  | ✅ **ACTIVE** — advisory only, exits 0; tested on good, bad and malformed input |
| `.gitignore` secret patterns                   | ✅ **ACTIVE** — 8/8 known-bad ignored, 7/7 known-good untouched                 |
| `.husky/pre-commit`                            | ✅ **ACTIVE** — `core.hooksPath` = `.husky`; chains the clean-room guard first  |
| `.husky/pre-push`                              | present · **runs, but guards nothing here** — see RM-05                         |
| `.github/workflows/cleanroom-guard.yml`        | present · execution on this commit **unverified**                               |
| `.github/workflows/proprietary-path-guard.yml` | present · historically gated to `FlowiseAI/Flowise`; **verify**                 |
| `.github/workflows/release-gate.yml`           | present · execution **unverified**                                              |
| `.github/workflows/security-scan.yml.disabled` | written · **deliberately not enabled** — scanners absent, so unverifiable       |

**A control is not in place until observed failing on known-bad input and passing on known-good
input, in the environment that runs it** (`PROCESS-GAPS.md` G1).

The clean-room hook was enabled on 2026-08-11 and verified **both ways**: an added file under
`packages/server/src/enterprise/` was rejected (exit 1), and ordinary staged changes were allowed
(exit 0). It was then **silently disabled the same day** when `pnpm install` ran `husky install`,
which reset `core.hooksPath` from `.githooks` to `.husky`; `.husky/pre-commit` now chains it
unconditionally so it survives reinstalls, and it was re-verified both ways through that path.
It has since gated four real commits. This closes the G1 condition for the local hook in this
clone. Remaining control work is RM-04/RM-05/RM-09 in
[`remediation-plan.md`](remediation-plan.md).

`.husky/pre-push` is **inherited upstream cruft**: it triggers only on pushes to
`FlowiseAI/Flowise` and blocks `extensions/` and `apps/` — paths that do not exist here. It
protects nothing in this repository. Flagged, not changed: it affects push behaviour.

## Working copy

-   Location `/mnt/s/code/flow-wiser`, on an **NFS4 mount**, nested inside an unrelated
    `ivrloadtester` checkout at `/mnt/s`. See `CLAUDE.md` for the hazards.
-   Local tag `pre-methodology-20260811` marks the pre-methodology checkout.
-   Untracked and deliberately left in place: `flow-wiser-keep-it-going.png`, and
    `flowise-credentials-backup-20260805-153047.json` — **real credential material**, root-owned
    `0600`, hard-ignored. Do not read, move or commit it.

## Drift

1. ~~**`STATUS.md` contradicts the tree.**~~ **WITHDRAWN 2026-08-12 — this drift did not exist.**
   The claims quoted here ("not started", "not registered", "not deleted") came from a **stale
   docs-only copy dated 2026-08-05** that occupied the working directory before the repository
   was materialized — not from `docs/STATUS.md`. The real file is dated 2026-08-09 and says the
   opposite: released, Apache-2.0-only, licensed files deleted, RBAC shipped. See RM-06.
2. **Migration counts differ across engines** (53/55/57/56) — unverified whether legitimate.
3. **`testing.md`, `bug-log.md`, `release-readiness.md` are pinned to the `3.1.4-fw8` QA run**
   while the tree is `3.1.4-fw10`. Their findings may be closed, superseded or still open;
   status per item is unverified at `fw10`.

## Next

See [`remediation-plan.md`](remediation-plan.md).
