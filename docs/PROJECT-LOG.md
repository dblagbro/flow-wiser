# Flow-Wiser Project Log

Decisions, findings and requirements. Newest first.

---

## 2026-08-05 — Fork established, patched, rebranded, published

### Context

FlowiseAI announced end of life 2026-08-03: code freeze 2026-07-29, upstream repository
archived 2026-08-10, maintainers depart 2026-08-31. The sunset notice explicitly
encourages community forks: *"the Apache 2.0 licensed code is yours to keep building on."*

### Findings — three defects in upstream's container build

**1. Every published image shipped the wrong server package.**

| Image tag | Server actually shipped |
| --- | --- |
| `flowiseai/flowise:3.1.2` | `flowise@3.1.2` |
| `flowiseai/flowise:3.1.3` | `flowise@3.1.2` ❌ |
| `flowiseai/flowise:3.1.4` | `flowise@3.1.2` ❌ |

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

- **116 published advisories** all-time. **26 published 2026-08-04 alone** — 10 critical,
  13 high, 3 medium — the day after the sunset announcement.
- No unpatched advisory applies above 3.0.12; all five unpatched criticals top out at
  `<= 3.0.5`.
- `vm2` resolved to **3.11.2** with **six critical sandbox escapes** open. Pinned to
  3.11.5. A sandbox escape is an RCE primitive — the first link in
  *RCE → read `database.sqlite` → decrypt credentials → exfiltrate API keys*.
- Upstream's `SECURITY.md` states vulnerability reports are no longer accepted. Replaced.

### Findings — deployment (operator instance)

- Full `/api/v1/` surface was publicly proxied with no allowlist. 14 high-risk endpoints
  now restricted to trusted networks.
- Request logs show **four distinct attack campaigns** (2024-09-22, 2025-01-15/16,
  2025-07-06, 2025-07-27/28), plus a persistent actor rotating **seven addresses from
  `185.177.72.0/24` across eight months**. Payloads targeted products not in use
  (Superset, Ambari endpoints, `admin:admin`, a Flask session blob) — no evidence of
  success, though the request log lacks response codes.
- `FLOWISE_SECRETKEY_OVERWRITE` was set to `myencryptionkey` — the value published in
  `.env.example`. Credential encryption with a publicly documented key. Drove requirement
  §1 in `REQUIREMENTS-AUTH-RBAC.md`.
- **Credential deletion orphaned 37 references across 21 flows**, taking down the public
  chatbot. Flows bind credentials by UUID, so delete-and-recreate silently breaks them.
  Drove requirement §3.

### Lessons recorded

- **Per-step assertions cannot catch a later step undoing an earlier one.** `3.1.4-fw2`
  was built and discarded: pinning `connect-sqlite3` and `vm2` in separate `RUN` steps let
  the later `npm install` revert the earlier pin. The build printed
  `connect-sqlite3 pinned to 0.9.16` and its assertion passed. Both pins now apply in one
  install, with a final gate after all mutations.
- **Single-file bind mounts bind the inode.** `sed -i` writes a new file and renames,
  severing the mount silently. Use in-place writes; verify with `stat -c %i` on both sides.
- **Flowise's SVG filenames are theme-based, not ink-based.** `flowise_white-*.svg` loads
  in *light* mode and needs *dark* ink. Matching ink to filename yields a logo that
  returns HTTP 200, reports correct dimensions, and is invisible.
- **Vite content hashes** in asset filenames mean every branding mount must be re-checked
  after a UI version bump, or it silently stops applying.

### Delivered

- Fork established, full history + 307 tags + 42 restored releases.
- `upstream-archive/` — **347 open PRs** as git-am-able patches with original authors
  preserved, **698 issues**, **116 advisories**, **100 discussions**, captured before the
  2026-08-10 lock.
- Adopted CVE-2026-27699 and CVE-2026-33863 from upstream PRs #6683/#6682 by
  **@anupamme**, re-pinned via `pnpm.overrides` — the contributors' original placement in
  root `dependencies` would not have forced the transitive versions.
- Releases `v3.1.4-fw1` and `v3.1.4-fw3`; images at `dblagbro/flow-wiser`.
- Own visual identity — Apache 2.0 §6 grants no trademark rights.

---

## Standing requirements

| Requirement | Source |
| --- | --- |
| 100% open source — remove all 127 commercially-licensed files | Operator, repeatedly and explicitly |
| **Different and better** function, not a clone | Operator |
| **Keep the original UI essentially unchanged** — free, since `packages/ui` is Apache 2.0 with zero enterprise files | Operator |
| Never read the proprietary files while building replacements | Operator; see `CLEANROOM-PROTOCOL.md` |
| Full flow + prompt versioning with non-destructive restore | Operator; see `REQUIREMENTS-VERSIONING.md` |
| RBAC — full rewrite acceptable, need not follow upstream's design | Operator |
| Open-source building blocks welcome where they help | Operator |
| No secrets, keys or PII in anything published | Operator |
| Publish to both GitHub and Docker Hub | Operator |

### Rejected approaches (recorded with reasons)

- **Reverse engineering the proprietary files, including via another LLM.** Unnecessary —
  the whole interface is derivable from Apache-2.0 sources. Actively harmful: it
  manufactures a derivative-work argument where none currently exists. The *absence* of
  reverse engineering is the strongest fact in our favour.
- **A companion service in another language to sidestep licensing.** Copyright protects
  expression, not language choice or process boundaries. A port of copied logic infringes
  identically. Legitimate as an *architecture* choice; worthless as a *legal* one.
- **Declaring the repository Apache 2.0 as-is.** Void. The copyright in those 127 files is
  FlowiseAI's; no fork can relicense code it does not own.

---

## Current state

**94.67%** Apache 2.0 by file count (2,255 / 2,382) · **95.58%** by lines (296,683 / 310,387).

The remaining 5% is one coherent subsystem — authentication, SSO, RBAC, multi-tenancy —
and it is load-bearing: 3.x deleted the Apache-2.0 auth, so deleting these files without a
replacement yields an unauthenticated server.

**Next:** `REQUIREMENTS-AUTH-RBAC.md` (reaches 100% and delivers RBAC) and
`REQUIREMENTS-VERSIONING.md` (independent, ships anytime).
