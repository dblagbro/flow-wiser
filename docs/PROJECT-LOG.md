# Flow-Wiser Project Log

Decisions, findings and requirements. Newest first.

---

## 2026-08-09 — `3.1.4-fw8`: the baseline, and four days of red CI nobody saw

### What happened

Between 2026-08-05 and 2026-08-09 Node CI failed on every commit. Three releases — `fw5`, `fw6`,
`fw7` — were tagged, published to Docker Hub and deployed in that window, two of them while an
external security team held the repository. The releases were functionally sound; the deployed fw7
passed every manual check and is still running. What was missing was any evidence that they were.

The cause was one line: the flow-versioning work added `isomorphic-git` to `packages/server/package.json`
and never regenerated `pnpm-lock.yaml`, so `--frozen-lockfile` failed before jest started.

### The part that mattered more than the cause

Four independent failures were stacked, each invisible until the one above it was removed:
the lockfile, then 45 lint errors, then an ESM-only dependency pinned by a wrong security override,
then Cypress starting the server with no encryption key. Removing any one changed nothing observable,
which is why three days of work sat on top of it without anyone noticing.

Underneath all of it, `test/identity/recovery-cli.test.ts` — 30 tests, and the only evidence that
REQUIREMENTS-MIGRATION §7 holds — had never executed. Its docblock openly documented that `pnpm test`
would not pick it up and offered a hand-run command instead. A comment asking a human to remember
something is not a control. Worse, it had rotted while dead: five assertions were asserting schema
defects that `1780000000012-AddTenancyColumnsToCoreTables` had already repaired.

### Decisions

-   **Cut `fw8` rather than re-tag `fw7`.** No product code changed between them. Re-tagging would have
    pointed a published release at a different tree than the image built from it, and rewriting the
    history of a release that shipped to an external team would be worse than recording that it shipped
    on a red build. `fw8` exists so QA has a baseline whose evidence holds.
-   **Flip the stale assertions, do not delete them.** A check that silently stops running must stay
    distinguishable from a defect that got fixed.
-   **Reject a test-count floor** in favour of comparing the filesystem against `jest --listTests`. A
    floor drifts downward as tests are legitimately deleted and cannot tell a deliberate removal from a
    suite that stopped being discovered.
-   **HSTS without `includeSubDomains` or `preload`.** Every HTTPS host at this edge is named in the
    server blocks and sends HSTS for itself, so coverage is identical; `includeSubDomains` would pin
    unenumerated subdomains for a year. Two other domains sharing this proxy have had expired
    certificates since 2026-03-18 — exactly where HSTS converts a clickable warning into an outage.
-   **`enforce_admins` on**, accepting that direct pushes to `main` become impossible and every change
    needs a PR. The previous setting printed `Bypassed rule violations` and let the push through, which
    is a receipt, not a gate.

### Findings not related to the fork

-   **The edge had been serving a stale configuration since 2026-08-07.** `nginx.conf` is bind-mounted
    as a _file_, and a file bind mount is pinned to an inode at container start; rewriting the file made
    a new inode and the container kept the old one. `nginx -s reload` reported success throughout. The
    only functional difference was the IP allowlist removed on 2026-08-07 at the operator's direction —
    **that change had never taken effect.**
-   **Verifications that could not fail.** Every check of that allowlist had been issued from this host,
    whose address is inside it. Earlier the same day, `git push --dry-run` reported success against a
    branch with `enforce_admins` enabled — dry-run does not evaluate protection rules. Three instances in
    one day of a test that returns success regardless of the answer.

### State at close

`3.1.4-fw8` released; CI green on the released commit; 974 tests (up from 937); branch protection with
`enforce_admins`; release gate on tags and releases; test-discovery check in CI; HSTS live and verified
from outside the network. Open: `vm2`, 12 dangling credential references, audit tamper-proofing,
alerting, data classification, ungated image publication, undetected edge drift.

Next: full QA against `docs/BASELINE-3.1.4-fw8.md`.

---

## 2026-08-05 — Fork established, patched, rebranded, published

### Context

FlowiseAI announced end of life 2026-08-03: code freeze 2026-07-29, upstream repository to be
archived 2026-08-10, maintainers depart 2026-08-31. The sunset notice explicitly
encourages community forks: _"the Apache 2.0 licensed code is yours to keep building on."_

> **Correction, 2026-08-12.** The announced archive did not occur. `FlowiseAI/Flowise` reports
> `archived: false` and remains unlocked, and **three pull requests were merged on 2026-08-07** —
> after the announced code freeze. The entry below was written on the assumption the archive had
> happened; the announcement was real, the archival was not. See
> [`../upstream-archive/DELTA-2026-08-12.md`](../upstream-archive/DELTA-2026-08-12.md).

### Findings — three defects in upstream's container build

**1. Every published image shipped the wrong server package.**

| Image tag                 | Server actually shipped |
| ------------------------- | ----------------------- |
| `flowiseai/flowise:3.1.2` | `flowise@3.1.2`         |
| `flowiseai/flowise:3.1.3` | `flowise@3.1.2` ❌      |
| `flowiseai/flowise:3.1.4` | `flowise@3.1.2` ❌      |

`docker/Dockerfile` ran an unpinned `npm install -g flowise`. The version was not part of
the Docker layer cache key, so later builds reused the layer from when npm's `latest` was
3.1.2. `flowise@3.1.3` and `@3.1.4` are published correctly on npm; **no official image
ever contained them**. The 25 advisories fixed in 3.1.3 were therefore absent from every
published image — while the version endpoint truthfully reported `3.1.2` and the tag
claimed otherwise.

**2. `connect-sqlite3@0.9.17` — the true root cause of upstream issue #6688.**

Not a 3.1.4 regression. 0.9.17 changed its constructor so `this.db.exec` no longer exists,
throwing during session-store setup at boot. Because the dependency is unpinned, **any**
Flowise container built after 0.9.17 shipped fails, at any version:

```
official flowiseai/flowise:3.1.3, built earlier -> connect-sqlite3 0.9.16 -> boots
fresh build of that same flowise@3.1.3, today   -> connect-sqlite3 0.9.17 -> crashes
```

The "3.1.3 works, 3.1.4 is broken" split the community observed is an artifact of **when
each image was built**. Published to #6688 and #6706 before archival.

**3. `ARG NODE_VERSION=24` cannot build.** `better-sqlite3` fails under node-gyp. Every
published image runs Node v20.20.2, so CI was overriding the default and the breakage went
unnoticed.

### Findings — security

-   **116 published advisories** all-time. **26 published 2026-08-04 alone** — 10 critical,
    13 high, 3 medium — the day after the sunset announcement.
-   No unpatched advisory applies above 3.0.12; all five unpatched criticals top out at
    `<= 3.0.5`.
-   `vm2` resolved to **3.11.2** with **six critical sandbox escapes** open. Pinned to
    3.11.5. A sandbox escape is an RCE primitive — the first link in
    _RCE → read `database.sqlite` → decrypt credentials → exfiltrate API keys_.
-   Upstream's `SECURITY.md` states vulnerability reports are no longer accepted. Replaced.

### Findings — deployment (operator instance)

-   Full `/api/v1/` surface was publicly proxied with no allowlist. 14 high-risk endpoints
    now restricted to trusted networks.
-   Request logs show **four distinct attack campaigns** (2024-09-22, 2025-01-15/16,
    2025-07-06, 2025-07-27/28), plus a persistent actor rotating **seven addresses from
    `185.177.72.0/24` across eight months**. Payloads targeted products not in use
    (Superset, Ambari endpoints, `admin:admin`, a Flask session blob) — no evidence of
    success, though the request log lacks response codes.
-   `FLOWISE_SECRETKEY_OVERWRITE` was set to `myencryptionkey` — the value published in
    `.env.example`. Credential encryption with a publicly documented key. Drove requirement
    §1 in `REQUIREMENTS-AUTH-RBAC.md`.
-   **Credential deletion orphaned 37 references across 21 flows**, taking down the public
    chatbot. Flows bind credentials by UUID, so delete-and-recreate silently breaks them.
    Drove requirement §3.

### Lessons recorded

-   **Per-step assertions cannot catch a later step undoing an earlier one.** `3.1.4-fw2`
    was built and discarded: pinning `connect-sqlite3` and `vm2` in separate `RUN` steps let
    the later `npm install` revert the earlier pin. The build printed
    `connect-sqlite3 pinned to 0.9.16` and its assertion passed. Both pins now apply in one
    install, with a final gate after all mutations.
-   **Single-file bind mounts bind the inode.** `sed -i` writes a new file and renames,
    severing the mount silently. Use in-place writes; verify with `stat -c %i` on both sides.
-   **Flowise's SVG filenames are theme-based, not ink-based.** `flowise_white-*.svg` loads
    in _light_ mode and needs _dark_ ink. Matching ink to filename yields a logo that
    returns HTTP 200, reports correct dimensions, and is invisible.
-   **Vite content hashes** in asset filenames mean every branding mount must be re-checked
    after a UI version bump, or it silently stops applying.

### Delivered

-   Fork established, full history + 307 tags + 42 restored releases.
-   `upstream-archive/` — **347 open PRs** as git-am-able patches with original authors
    preserved, **698 issues**, **116 advisories**, **100 discussions**, captured 2026-08-05 ahead
    of the announced 2026-08-10 lock. **That lock did not happen** — see the correction above.
    Refreshed 2026-08-12: 346 open PRs, 701 open issues.
-   Adopted CVE-2026-27699 and CVE-2026-33863 from upstream PRs #6683/#6682 by
    **@anupamme**, re-pinned via `pnpm.overrides` — the contributors' original placement in
    root `dependencies` would not have forced the transitive versions.
-   Releases `v3.1.4-fw1` and `v3.1.4-fw3`; images at `dblagbro/flow-wiser`.
-   Own visual identity — Apache 2.0 §6 grants no trademark rights.

---

## Standing requirements

| Requirement                                                                                                         | Source                                     |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 100% open source — remove all 127 commercially-licensed files                                                       | Operator, repeatedly and explicitly        |
| **Different and better** function, not a clone                                                                      | Operator                                   |
| **Keep the original UI essentially unchanged** — free, since `packages/ui` is Apache 2.0 with zero enterprise files | Operator                                   |
| Never read the proprietary files while building replacements                                                        | Operator; see `CLEANROOM-PROTOCOL.md`      |
| Full flow + prompt versioning with non-destructive restore                                                          | Operator; see `REQUIREMENTS-VERSIONING.md` |
| RBAC — full rewrite acceptable, need not follow upstream's design                                                   | Operator                                   |
| Open-source building blocks welcome where they help                                                                 | Operator                                   |
| No secrets, keys or PII in anything published                                                                       | Operator                                   |
| Publish to both GitHub and Docker Hub                                                                               | Operator                                   |

### Rejected approaches (recorded with reasons)

-   **Reverse engineering the proprietary files, including via another LLM.** Unnecessary —
    the whole interface is derivable from Apache-2.0 sources. Actively harmful: it
    manufactures a derivative-work argument where none currently exists. The _absence_ of
    reverse engineering is the strongest fact in our favour.
-   **A companion service in another language to sidestep licensing.** Copyright protects
    expression, not language choice or process boundaries. A port of copied logic infringes
    identically. Legitimate as an _architecture_ choice; worthless as a _legal_ one.
-   **Declaring the repository Apache 2.0 as-is.** Void. The copyright in those 127 files is
    FlowiseAI's; no fork can relicense code it does not own.

---

## Current state

**94.67%** Apache 2.0 by file count (2,255 / 2,382) · **95.58%** by lines (296,683 / 310,387).

The remaining 5% is one coherent subsystem — authentication, SSO, RBAC, multi-tenancy —
and it is load-bearing: 3.x deleted the Apache-2.0 auth, so deleting these files without a
replacement yields an unauthenticated server.

**Next:** `REQUIREMENTS-AUTH-RBAC.md` (reaches 100% and delivers RBAC) and
`REQUIREMENTS-VERSIONING.md` (independent, ships anytime).
