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

## ⚖️ Licensing — read this before you redistribute

**Flowise is open core, not wholly open source.** The upstream [`LICENSE.md`](LICENSE.md) splits the
repository into two parts, and **this fork preserves that split exactly as upstream published it.**
Your rights and obligations are identical to what they were when obtaining the code from upstream —
this fork grants you nothing more, and takes nothing away.

### ✅ Apache License 2.0 — the open-source majority

Everything **except** the paths listed in the next section is licensed under the
[Apache License, Version 2.0](LICENSE.md). You may use, modify, distribute, and sublicense
it — commercially included — subject to Apache 2.0's terms (attribution, NOTICE preservation,
and statement of changes).

This is the portion FlowiseAI referred to as *"yours to keep building on,"* and it is the portion
this fork exists to carry forward.

### ⚠️ Commercial License — NOT open source, NOT freely redistributable

The following **127 files** are governed by the separate
[FlowiseAI Inc Commercial License](packages/server/src/enterprise/LICENSE.md), **not** Apache 2.0:

| Path | Files |
| --- | --- |
| `packages/server/src/enterprise/` | 126 |
| `packages/server/src/IdentityManager.ts` | 1 |

That license permits copying and modification **for development and testing purposes only**, and
states that production use requires a valid FlowiseAI Enterprise subscription. It further states
that it is *"forbidden to copy, merge, publish, distribute, sublicense, and/or sell the Software."*

**Practical guidance for anyone using this fork:**

- These files are **inert at runtime** unless you supply a `FLOWISE_EE_LICENSE_KEY` environment
  variable. With no key set, the server runs in open-source mode and the enterprise code paths
  (SSO, RBAC, workspaces, organizations, seat quotas) are not activated.
- **Running** this fork without an enterprise license key is fine.
- **Redistributing** these 127 files — republishing to npm, Docker Hub, a public mirror, or
  bundling them into a product — is **not** covered by Apache 2.0 and is not something this fork
  can grant you. Do not assume the Apache 2.0 license on this repository extends to them.
- If you need a build you can redistribute without restriction, use an
  Apache-2.0-only variant with these paths removed. See *Roadmap* below.

**Nothing in this fork modifies, weakens, or reinterprets the upstream commercial license.**
It applies to you here exactly as it applied upstream.

### Third-party components

All third-party components incorporated into this software remain licensed under the original
licenses provided by their respective owners.

---

## Attribution and changes

Per Apache 2.0 §4, this fork carries the upstream [`NOTICE`](NOTICE) file and documents its changes.

- **Original work:** Copyright © 2023–present FlowiseAI, Inc. — https://github.com/FlowiseAI/Flowise
- **Fork point:** upstream commit `ba4c6509`, 2026-08-03
- **Changes made by this fork:** listed in [`NOTICE`](NOTICE) and in this file's *Roadmap*. At the
  fork point, the only changes are the addition of `FORK.md`, `NOTICE`, and a fork banner in
  `README.md`. **No upstream source code was modified.**

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
- [ ] Publish a **`community-oss`** branch containing only Apache-2.0-licensed code, with the 127
      commercially-licensed files removed and their ~60 dependent modules refactored to
      open-source-only equivalents. That branch will be freely redistributable in full.
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

The licensing summary in this document is a good-faith reading of the upstream license texts
provided for orientation. **It is not legal advice.** The authoritative terms are
[`LICENSE.md`](LICENSE.md) and [`packages/server/src/enterprise/LICENSE.md`](packages/server/src/enterprise/LICENSE.md).
If your intended use is commercially significant, consult a lawyer.
