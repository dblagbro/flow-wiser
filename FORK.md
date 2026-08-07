# Flow-Wiser — Open Source Release Copy

<p align="center">
  <a href="FLOW-WISER.md">
    <img width="420" src="community-art/flow-wiser-keep-it-going-900.webp" alt="Flow-wiser — help keep the flow going">
  </a>
</p>

> **This is an unofficial community fork of [FlowiseAI/Flowise](https://github.com/FlowiseAI/Flowise), preserved after the upstream project reached end of life in August 2026.**
>
> This fork is **not affiliated with, endorsed by, or sponsored by FlowiseAI, Inc. or Workday, Inc.**
> "Flowise" is a trademark of its respective owner. It is used here only to identify the
> upstream project this code originates from.

---

## Why this fork exists

On **2026-08-03**, FlowiseAI published a [sunset notice](https://flowiseai.com/sunset) announcing
the wind-down of the Flowise project. Their published timeline:

| Date | Milestone |
| --- | --- |
| 2026-07-29 | Code freeze — feature development stops (final release `flowise@3.1.4`) |
| 2026-08-10 | Upstream GitHub repository moves to **Public Archive** (issues and PRs locked) |
| 2026-08-31 | Official core team presence in Discord and GitHub concludes |

In that same notice, FlowiseAI explicitly encouraged continuation forks:

> *"Flowise source code will still remain on Github... the Apache 2.0 licensed code is yours to
> keep building on. We encourage teams to fork the repo... to maintain their own internal updates
> or community-led forks."*

This repository is one such fork. Its purpose is **preservation and continuity** — so that teams
already running Flowise in production have a living copy of the code, complete with its full
history, that does not depend on an archived upstream.

## What was preserved

This fork was taken from upstream commit [`ba4c6509`](https://github.com/FlowiseAI/Flowise/commit/ba4c6509)
(`feat(security): Sunset notice (#6692)`) — the final upstream state before archival.

- ✅ Complete git history (every upstream commit)
- ✅ All **307** release tags, `flowise@1.x` through `flowise@3.1.4`
- ✅ Full monorepo: `packages/server`, `packages/ui`, `packages/components`, `packages/api-documentation`
- ✅ Docker configuration, i18n, CI workflows, and documentation
- ✅ Upstream licensing structure preserved **exactly as published** — nothing was relicensed

---

## ⚖️ Licensing — this fork is 100% Apache 2.0

**Upstream Flowise was open core.** Its [`LICENSE.md`](LICENSE.md) split the repository in two, and
**127 files were not open source**:

| Path | Files |
| --- | --- |
| `packages/server/src/enterprise/` | 126 |
| `packages/server/src/IdentityManager.ts` | 1 |

Those were governed by a FlowiseAI Inc Commercial License permitting copying and modification for
development and testing only, requiring an Enterprise subscription for production use, and stating
that it is *"forbidden to copy, merge, publish, distribute, sublicense, and/or sell the Software."*
That made **no** Flowise fork freely redistributable, this one included.

### What changed

**Those 127 files have been deleted from this fork.** They are not in this repository, in any
branch published from it, or in any artifact built from it. The functionality they provided —
authentication, SSO, RBAC, multi-tenancy — was reimplemented from scratch under Apache 2.0 in
`packages/server/src/identity/`.

**Nothing was relicensed.** The copyright in those files is FlowiseAI's; no fork can relicense code
it does not own, and declaring this repository Apache 2.0 while they remained would have been both
void and dishonest.

**They also could not simply be deleted.** Flowise 3.0 removed the Apache-2.0
`FLOWISE_USERNAME` / `FLOWISE_PASSWORD` authentication when it introduced the commercial identity
stack, so dropping the 127 files without a replacement produces an **unauthenticated server** — on
a product with 116 published security advisories. Replacement was the only route to a
redistributable fork.

### How the replacement was written

The entire interface was already available under a licence permitting us to read it. `packages/ui/`
contains **zero** commercially licensed files and is the client that actually calls the server, so
it specifies the complete HTTP contract; `packages/server/src/routes/` carries 120 permission call
sites. A specification was derived from those Apache-2.0 sources alone — 53 endpoints, 82
permissions, 12 entities, 363 citations, and 15 explicitly recorded gaps where the interface did not
determine behaviour — and implemented against it.

**The commercially licensed files were never read**, and never fed to any tool for summarising or
porting. There was nothing to reverse engineer. A pre-commit hook and a CI job reject any commit
that modifies a protected path — deletion is permitted, modification is not, because editing implies
having read.

| Document | What it holds |
| --- | --- |
| [`docs/CLEANROOM-PROTOCOL.md`](docs/CLEANROOM-PROTOCOL.md) | The binding process and its prohibitions |
| [`docs/CLEANROOM-ATTESTATION.md`](docs/CLEANROOM-ATTESTATION.md) | Evidence, with commands you can re-run. Includes a disclosed incident where a malformed command exposed ~12 lines of one protected file, and the remediation |
| [`docs/SPEC-AUTH-RBAC.md`](docs/SPEC-AUTH-RBAC.md) | The specification and its citations |
| [`docs/HOW-WE-DID-THIS.md`](docs/HOW-WE-DID-THIS.md) | The method, written to be reusable on other open-core projects |

### What this means for you

- **You may redistribute this fork in full** — republish to npm, Docker Hub, a public mirror, or
  bundle it into a product — subject to Apache 2.0's terms (attribution, NOTICE preservation,
  statement of changes).
- You do not need, and cannot use, a `FLOWISE_EE_LICENSE_KEY`. There are no licence-gated features;
  there is nothing to sell.
- **`3.1.4-fw4` and later are redistributable.** They are built from the root `Dockerfile`,
  which compiles this repository, and the build fails outright if any `dist/enterprise/`
  path or `IdentityManager` artifact is present anywhere on the image.
- **Container images published before 2026-08-06** (`3.1.4-fw1` through `3.1.4-fw3`) were built
  from `docker/Dockerfile`, which installs FlowiseAI's published npm package — and that
  package contains the commercially licensed compiled output. Those images **do** contain
  it, and the commercial terms govern them wherever you obtained them. They are superseded;
  move to `3.1.4-fw4`.
- **`docker/Dockerfile` cannot produce a redistributable image**, whatever this repository
  contains, because the material arrives from npm rather than from the tree. Publish only
  from the root `Dockerfile`.

**This fork does not modify, weaken, or reinterpret the upstream commercial license.** It removed
the files it covered instead.

### Third-party components

All third-party components incorporated into this software remain licensed under the original
licenses provided by their respective owners.

---

## Attribution and changes

Per Apache 2.0 §4, this fork carries the upstream [`NOTICE`](NOTICE) file and documents its changes.

- **Original work:** Copyright © 2023–present FlowiseAI, Inc. — https://github.com/FlowiseAI/Flowise
- **Fork point:** upstream commit `ba4c6509`, 2026-08-03
- **Changes made by this fork:** listed in [`NOTICE`](NOTICE) and [`CHANGELOG.md`](CHANGELOG.md).
  At the fork point the only changes were `FORK.md`, `NOTICE`, and a README banner, with no
  upstream source modified. Since then: three container-build defects fixed, the 127
  commercially licensed files removed, and an Apache-2.0 identity, RBAC, MFA, audit and
  multi-tenancy implementation added.

## Trademark

Apache License 2.0 **§6 expressly does not grant trademark rights.** "Flowise", "FlowiseAI", and
associated logos are trademarks of FlowiseAI, Inc. / Workday, Inc. This fork uses the name only
nominatively — to accurately identify the upstream project the code derives from — and does not
claim any affiliation, endorsement, or sponsorship. If you fork this repository further and intend
to distribute it as a product, consider adopting a distinct name, following the precedent of
OpenSearch, OpenTofu, Valkey, and OpenBao.

## Roadmap

- [x] Preserve the full upstream repository and all 307 release tags before the 2026-08-10 archival
- [x] Document the Apache 2.0 / Commercial licensing split explicitly
- [x] Remove the 127 commercially licensed files and refactor every dependent module, so the
      repository is **100% Apache 2.0** and freely redistributable in full
- [x] Replace the removed identity stack: authentication, RBAC, SSO, MFA, audit, encryption at
      rest, multi-tenancy, migration from an existing Flowise database, and a recovery CLI
- [x] Publish an Apache-2.0-only container image — `3.1.4-fw4`, 2026-08-06
- [ ] Chatflow version history
- [ ] Replace `vm2` outright rather than pinning it
- [ ] Triage and carry forward outstanding upstream security patches

## Contributing

Issues and pull requests are open. Contributions are accepted under the Apache License 2.0
(per Apache 2.0 §5), and **must not** touch the commercially-licensed paths listed above.

## Related upstream repositories

If you are assembling a complete self-hosted stack, note that the satellite repositories carry
different licensing:

| Repository | License | Safe to fork? |
| --- | --- | --- |
| [FlowiseAI/FlowiseSDK](https://github.com/FlowiseAI/FlowiseSDK) | MIT | ✅ Yes |
| [FlowiseAI/FlowisePy](https://github.com/FlowiseAI/FlowisePy) | MIT | ✅ Yes |
| [FlowiseAI/FlowiseChatEmbed](https://github.com/FlowiseAI/FlowiseChatEmbed) | **No license file** | ❌ All rights reserved |
| [FlowiseAI/FlowiseEmbedReact](https://github.com/FlowiseAI/FlowiseEmbedReact) | **No license file** | ❌ All rights reserved |
| [FlowiseAI/FlowiseDocs](https://github.com/FlowiseAI/FlowiseDocs) | **No license file** | ❌ All rights reserved |

A repository published without a license file is **not** open source — default copyright applies
and no redistribution rights are granted. Do not mirror those three without permission.

---

## Disclaimer

This software is provided **"as is", without warranty of any kind**, express or implied, per
Apache License 2.0 §7 and §8. This fork is maintained on a best-effort basis and carries no
service-level commitment.

The licensing summary in this document is a good-faith account provided for orientation. **It is
not legal advice.** The authoritative terms for this repository are [`LICENSE.md`](LICENSE.md).
The commercial licence that formerly applied to the removed files was published upstream at
`packages/server/src/enterprise/LICENSE.md`; it is not reproduced here because those files are
gone, and it is retrievable from upstream history. If your intended use is commercially
significant, consult a lawyer.
