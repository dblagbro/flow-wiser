<!-- markdownlint-disable MD030 -->

# Flowise, actually open source — `3.1.4-fw10`

```bash
docker pull dblagbro/flow-wiser:3.1.4-fw10     # or :latest
```

Upstream Flowise was **open core**. 127 files — `packages/server/src/enterprise/` and
`IdentityManager.ts` — carried a FlowiseAI Commercial License forbidding copying,
publishing and distribution, and they were the ones holding authentication. So no Flowise
fork could be redistributed, and no fork could delete them without shipping an
unauthenticated server.

**Flow-Wiser is the first Flowise container anyone may freely redistribute.** Those files
are gone, and authentication, RBAC, SSO, MFA, audit, encryption at rest and multi-tenancy
have been reimplemented from scratch under Apache 2.0 — without ever reading them. The
build now *fails* if any commercially licensed artifact appears anywhere on the image.

**`3.1.4-fw10` is the baseline.** It is the first release whose commit passes CI — fw5, fw6
and fw7 were tagged while the build was red and nobody was told, which is documented rather
than quietly fixed (`docs/PROCESS-GAPS.md`, G9–G11). No product code changed between fw7 and
fw8; what changed is that the claims about it became checkable. Start here:
**[BASELINE-3.1.4-fw10.md](docs/BASELINE-3.1.4-fw10.md)** — what is verified, how, and what is
explicitly *not* fixed.

| | |
| --- | --- |
| Redistributable | ✅ 100% Apache 2.0, no carve-outs |
| Authentication | ✅ Local password, sessions, SSO, TOTP MFA with recovery codes |
| Authorization | ✅ 82 permissions, deny-by-default, **enforced server-side** |
| Multi-tenancy | ✅ Organisations and workspaces, tenant key on the row |
| Recovery | ✅ Nine-command CLI, passwords read from `/dev/tty` only |
| Fresh install | ✅ SQLite, Postgres, MySQL, MariaDB |
| Encryption at rest | ✅ AES-256-GCM, HKDF-SHA-256, per-record nonce, key versioning, rotation command |
| HSTS at the edge | ✅ Verified on the wire from outside the network |
| CI on the released commit | ✅ 974 tests, lint, build, Cypress — green |
| Code sandbox | ⚠️ `vm2`, deprecated. Escapes blocked by configuration, not architecture. `CODE_EXECUTION_MODE=disabled` removes the risk class |

📄 **[Baseline & QA scope](docs/BASELINE-3.1.4-fw10.md)** · **[CHANGELOG](CHANGELOG.md)** ·
**[Known issues](docs/ISSUE-REGISTER.md)** · **[Compliance posture](docs/COMPLIANCE-POSTURE.md)** ·
**[FORK.md](FORK.md)** — read before redistributing

> ⚠️ **`3.1.4-fw1` through `3.1.4-fw3` are superseded and are *not* redistributable.** They
> were built before the removal, from a Dockerfile that installs FlowiseAI's published npm
> package, and so they contain the commercially licensed compiled output. The commercial
> terms govern those images wherever you obtained them. If you are running one, move to
> `fw8`.

---

# 🚨 If you run Flowise in Docker, read this first

**Every official `flowiseai/flowise` image ships the `flowise@3.1.2` server — whatever tag you pulled.**

| Image tag | Server package actually inside it |
| --- | --- |
| `flowiseai/flowise:3.1.2` | `flowise@3.1.2` |
| `flowiseai/flowise:3.1.3` | **`flowise@3.1.2`** ❌ |
| `flowiseai/flowise:3.1.4` | **`flowise@3.1.2`** ❌ |

`flowise@3.1.3` and `@3.1.4` **are** published correctly on npm. No official Docker image ever contained them.

### Check your own instance — 5 seconds

```bash
curl -s http://localhost:3000/api/v1/version
```

**If that returns `3.1.2` while you are running a `3.1.3` or `3.1.4` image, you are affected** — you are missing every server-side security fix released in 3.1.3.

---

## Why it happened

`docker/Dockerfile` installed Flowise like this:

```dockerfile
RUN npm install -g flowise            # ← no version
```

Docker caches each `RUN` layer by the **text of the command**. That text never changes, so once the layer existed it was reused on every subsequent build — permanently freezing whatever npm's `latest` happened to be the first time. That was **3.1.2**.

Releasing 3.1.3 and 3.1.4 to npm did nothing: the image build never re-ran the install. The tag advanced; the contents did not. And nothing failed loudly, because a stale-but-working install looks exactly like a fresh one.

**Impact:** the **25 security advisories fixed in `flowise@3.1.3`** — several of them critical RCEs — were absent from every published image, while `/api/v1/version` truthfully reported `3.1.2` and the tag claimed otherwise.

## How we fixed it

**1. Put the version in the layer cache key.**

```dockerfile
ARG FLOWISE_VERSION=latest
RUN npm install -g "flowise@${FLOWISE_VERSION}"
```

A build arg participates in the cache key, so changing the requested version invalidates the layer. The bug becomes structurally impossible.

**2. Assert it, because caching bugs are silent.**

```dockerfile
RUN INSTALLED="$(node -p "require('/usr/local/lib/node_modules/flowise/package.json').version")" \
    && if [ "${FLOWISE_VERSION}" != "latest" ] && [ "${INSTALLED}" != "${FLOWISE_VERSION}" ]; then \
         echo "FATAL: requested ${FLOWISE_VERSION} but installed ${INSTALLED}" >&2; exit 1; \
       fi
```

The build now **fails loudly** rather than shipping a mislabelled image.

**3. Verify after every mutation, not after each step.**

Our first attempt pinned two dependencies in separate `RUN` steps and still shipped a broken image — `npm install` re-resolves the dependency tree, so the second install silently reverted the first pin. The build printed `pinned to 0.9.16` and its assertion passed, because the assertion ran *before* the regression. That image was discarded.

There is now a single final gate after **all** package mutations:

```
FINAL: flowise=3.1.4 connect-sqlite3=0.9.16 vm2=3.11.5
```

> **Per-step assertions cannot catch a later step undoing an earlier one.** This is the general lesson, and it is the same class of failure as the original bug: something that *looks* pinned but isn't.

---

## Bonus: upstream issue [#6688](https://github.com/FlowiseAI/Flowise/issues/6688) is not a 3.1.4 bug

The community diagnosis was "3.1.4 is broken." It isn't. **`connect-sqlite3@0.9.17`** changed its constructor so `this.db.exec` no longer exists, throwing during session-store setup at boot:

```
TypeError: this.db.exec is not a function
  at new SQLiteStore (connect-sqlite3/lib/connect-sqlite3.js:56:17)
```

Because that dependency is also unpinned, **any Flowise container built after 0.9.17 was published fails — at any version.** Reproduced:

| Build | connect-sqlite3 | Result |
| --- | --- | --- |
| official `3.1.3`, built earlier | 0.9.16 | boots |
| the **same** `flowise@3.1.3`, rebuilt today | 0.9.17 | crashes identically |

So the "3.1.3 works, 3.1.4 is broken" split everyone observed is an artifact of **when each image was built** — not of anything that changed between the releases. Anyone rebuilding 3.1.3 to escape the 3.1.4 bug reproduces the crash.

**Fixed** by pinning `connect-sqlite3@0.9.16`, the last working constructor and what every functioning official image actually shipped. Reported upstream on [#6688](https://github.com/FlowiseAI/Flowise/issues/6688) and [#6706](https://github.com/FlowiseAI/Flowise/pull/6706) before archival.

## And a third: `ARG NODE_VERSION=24` cannot build

`better-sqlite3` fails to compile under node-gyp on Node 24 (`gyp ERR! not ok`). Every published image actually runs **Node v20.20.2**, so upstream CI was passing an override and the broken default went unnoticed — a plain `docker build` of their own Dockerfile fails. Defaulted to 20.

---

## Get a working, fully patched Flowise

```bash
docker pull dblagbro/flow-wiser:3.1.4-fw10     # or :latest
curl -s http://localhost:3000/api/v1/version  # {"version":"3.1.4-fw10"}
```

```
flowise=3.1.4-fw10   flowise-components=3.1.4-fw10   flowise-ui=3.1.4-fw10   vm2=3.11.5
```

Or build it yourself, from source, and watch the gates fire:

```bash
git clone https://github.com/dblagbro/flow-wiser && cd flow-wiser
docker build --no-cache --pull \
  --build-arg NODE_VERSION=20 \
  --build-arg FLOWISE_VERSION=3.1.4-fw10 \
  -t dblagbro/flow-wiser:3.1.4-fw10 .
```

That is the **root** `Dockerfile` — note the `.` context and the absence of `-f`. It
compiles this repository, from which the 127 commercially licensed files are deleted, and
it refuses to finish if any `dist/enterprise/` path or `IdentityManager` artifact turns up
anywhere on the resulting filesystem.

`docker/Dockerfile` is a different thing and does **not** build a release. It runs
`npm install -g flowise@<version>`, which fetches FlowiseAI's published package — and that
package still ships the commercially licensed compiled output. That is exactly how `fw1`
through `fw3` came to contain it. It is kept because it reproduces and documents the three
upstream container defects above, not because you should publish from it. It also cannot
build `fw4`: that version exists only in this repository, never on npm.

This closes **all 26 advisories published 2026-08-04** (10 critical, 13 high, 3 medium), including `GHSA-8gj2-2cvc-6xx7`, which required 3.1.4 and was previously unreachable because 3.1.4 would not start. It also upgrades **`vm2` 3.11.2 → 3.11.5**, closing six critical sandbox escapes — the RCE primitive that begins *RCE → read `database.sqlite` → decrypt credentials → exfiltrate API keys*. As of `fw4` that pin lives in the source tree rather than only in the npm-install Dockerfile, so a source build gets it too; before `fw4` it did not.

The `connect-sqlite3` boot crash cannot occur in `fw4` at all: it threw inside
`dist/enterprise/middleware/passport/SessionPersistance.js`, one of the deleted files, and
nothing in the tree imports `connect-sqlite3` any more.

⚠️ **Licensing — `3.1.4-fw1` through `3.1.4-fw3` only.** Like every Flowise container published before 2026-08-06, those images contain compiled output from `packages/server/src/enterprise/` and `IdentityManager.ts`, which are under FlowiseAI's **Commercial License**, not Apache 2.0, and their terms govern those components wherever you obtain them. Flow-Wiser could not and did not relicense them. **`3.1.4-fw10` is clean**: the repository no longer contains those files, the release image is built from source, and the build fails if any trace of them reaches it. See [FORK.md](FORK.md).

---

> # 🍴 Community Fork — Open Source Release Copy
>
> **This is an unofficial community continuation fork of [FlowiseAI/Flowise](https://github.com/FlowiseAI/Flowise).**
> It is **not affiliated with, endorsed by, or sponsored by FlowiseAI, Inc. or Workday, Inc.**
>
> FlowiseAI [announced end of life](https://flowiseai.com/sunset) for Flowise on **2026-08-03**
> (code freeze 2026-07-29, upstream repo archived 2026-08-10). They explicitly encouraged the
> community to fork: *"the Apache 2.0 licensed code is yours to keep building on."*
>
> This repository preserves the **complete upstream history and all 307 release tags** at final
> commit [`ba4c6509`](https://github.com/FlowiseAI/Flowise/commit/ba4c6509), so teams running
> Flowise have a living copy that does not depend on an archived upstream.
>
> ### ⚖️ Licensing at a glance — **100% Apache 2.0**
>
> | Scope | License | Redistributable? |
> | --- | --- | --- |
> | Everything in this repository | **Apache License 2.0** | ✅ Yes |
>
> Upstream Flowise was **open core**: 127 files — `packages/server/src/enterprise/` (126) plus
> `packages/server/src/IdentityManager.ts` — were under a FlowiseAI Commercial License that forbids
> copying, publishing and distribution. No Flowise fork could be freely redistributed.
>
> **Those files have been deleted from this fork**, and the functionality they provided —
> authentication, SSO, RBAC, multi-tenancy — reimplemented from scratch under Apache 2.0.
> Nothing was relicensed: no fork can relicense code it does not own, and no attempt was made.
>
> They could not simply be dropped, either. Flowise 3.0 removed the Apache-2.0 authentication when
> it introduced the commercial stack, so deleting them without a replacement yields an
> **unauthenticated server**.
>
> The replacement was derived only from Apache-2.0 sources already in the repository — principally
> `packages/ui/`, which contains no commercially licensed files and is the client that calls the
> server. **The commercially licensed files were never read.** A pre-commit hook and a CI job
> reject any commit touching a protected path.
>
> - [docs/CLEANROOM-PROTOCOL.md](docs/CLEANROOM-PROTOCOL.md) — the binding process
> - [docs/CLEANROOM-ATTESTATION.md](docs/CLEANROOM-ATTESTATION.md) — evidence, with commands you
>   can re-run yourself, including a disclosed near-miss we published rather than omitted
> - [docs/HOW-WE-DID-THIS.md](docs/HOW-WE-DID-THIS.md) — the method, written to be reusable on
>   other open-core projects
>
> 👉 **Read [FORK.md](FORK.md) before redistributing, and see [NOTICE](NOTICE) for attribution.**
>

<!-- flow-wiser-community-art -->
<p align="center">
  <a href="FLOW-WISER.md">
    <img width="600" src="community-art/flow-wiser-keep-it-going-900.webp" alt="Flow-wiser community open-source meme">
  </a>
</p>
<p align="center"><strong>Help keep the flow going - fork it, fix it, ship it.</strong></p>


<p align="center">
<img src="https://github.com/FlowiseAI/Flowise/blob/main/images/flowise_white.svg#gh-light-mode-only">
<img src="https://github.com/FlowiseAI/Flowise/blob/main/images/flowise_dark.svg#gh-dark-mode-only">
</p>

<div align="center">

[![Release Notes](https://img.shields.io/github/release/FlowiseAI/Flowise)](https://github.com/FlowiseAI/Flowise/releases)
[![Discord](https://img.shields.io/discord/1087698854775881778?label=Discord&logo=discord)](https://discord.gg/jbaHfsRVBW)
[![Twitter Follow](https://img.shields.io/twitter/follow/FlowiseAI?style=social)](https://twitter.com/FlowiseAI)
[![GitHub star chart](https://img.shields.io/github/stars/FlowiseAI/Flowise?style=social)](https://star-history.com/#FlowiseAI/Flowise)
[![GitHub fork](https://img.shields.io/github/forks/FlowiseAI/Flowise?style=social)](https://github.com/FlowiseAI/Flowise/fork)

English | [繁體中文](./i18n/README-TW.md) | [简体中文](./i18n/README-ZH.md) | [日本語](./i18n/README-JA.md) | [한국어](./i18n/README-KR.md)

</div>

<h3>Build AI Agents, Visually</h3>
<a href="https://github.com/FlowiseAI/Flowise">
<img width="100%" src="https://github.com/FlowiseAI/Flowise/blob/main/images/flowise_agentflow.gif?raw=true"></a>

## 📚 Table of Contents

-   [⚡ Quick Start](#-quick-start)
-   [🐳 Docker](#-docker)
-   [👨‍💻 Developers](#-developers)
-   [🌱 Env Variables](#-env-variables)
-   [📖 Documentation](#-documentation)
-   [🌐 Self Host](#-self-host)
-   [☁️ Flowise Cloud](#️-flowise-cloud)
-   [🙋 Support](#-support)
-   [🙌 Contributing](#-contributing)
-   [📄 License](#-license)

## ⚡Quick Start

Download and Install [NodeJS](https://nodejs.org/en/download) >= 20.0.0

1. Install Flowise
    ```bash
    npm install -g flowise
    ```
2. Start Flowise

    ```bash
    npx flowise start
    ```

3. Open [http://localhost:3000](http://localhost:3000)

## 🐳 Docker

### Docker — quickest path

Two values are **required**. The server will not issue sessions without them and will not invent
them, because a generated encryption key silently strands every credential written under the
previous one. Generate your own; the keyring rejects published example strings.

```bash
docker run -d --name flow-wiser -p 3000:3000 \
  -e IDENTITY_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  -e FLOWISE_SESSION_PEPPER="$(openssl rand -base64 32)" \
  -v flow-wiser-data:/root/.flowise \
  dblagbro/flow-wiser:3.1.4-fw10
```

**Record both values somewhere safe and separate from your backups.** They live only in the
environment, so a backup of `/root/.flowise` alone cannot restore a working instance.

Then create the first administrator — there is no self-registration:

```bash
docker exec -it flow-wiser flowise admin:create --email you@example.com --role super-admin
```

The password is prompted for on the terminal only; it is never accepted as a flag, a pipe, or an
environment variable. Open [http://localhost:3000](http://localhost:3000).

### Docker Compose

> ⚠️ The `docker/` directory is **upstream's** compose file and pins `flowiseai/flowise:latest` —
> the non-redistributable image this fork exists to replace (see [FORK.md](FORK.md)). It is kept
> for reproducing upstream's images, not for running Flow-Wiser. Write your own compose file using
> the `docker run` invocation above as the reference.

### Building the image yourself

`NODE_VERSION=20` is not optional — Node 24 cannot compile `better-sqlite3`. Passing
`FLOWISE_VERSION` makes the build assert that the tag matches what the tree declares, so a
mislabelled image cannot be produced:

1. Build:

    ```bash
    docker build --no-cache --pull \
      --build-arg NODE_VERSION=20 \
      --build-arg FLOWISE_VERSION=3.1.4-fw10 \
      -t dblagbro/flow-wiser:3.1.4-fw10 .
    ```

2. Run it with the same `-e`/`-v` flags shown above.

3. Stop:

    ```bash
    docker stop flow-wiser
    ```

## 👨‍💻 Developers

Flowise has 3 different modules in a single mono repository.

-   `server`: Node backend to serve API logics
-   `ui`: React frontend
-   `components`: Third-party nodes integrations
-   `api-documentation`: Auto-generated swagger-ui API docs from express

### Prerequisite

-   Install [PNPM](https://pnpm.io/installation)
    ```bash
    npm i -g pnpm
    ```

### Setup

1.  Clone the repository:

    ```bash
    git clone https://github.com/FlowiseAI/Flowise.git
    ```

2.  Go into repository folder:

    ```bash
    cd Flowise
    ```

3.  Install all dependencies of all modules:

    ```bash
    pnpm install
    ```

4.  Build all the code:

    ```bash
    pnpm build
    ```

    <details>
    <summary>Exit code 134 (JavaScript heap out of memory)</summary>  
    If you get this error when running the above `build` script, try increasing the Node.js heap size and run the script again:

    ```bash
    # macOS / Linux / Git Bash
    export NODE_OPTIONS="--max-old-space-size=4096"

    # Windows PowerShell
    $env:NODE_OPTIONS="--max-old-space-size=4096"

    # Windows CMD
    set NODE_OPTIONS=--max-old-space-size=4096
    ```

    Then run:

    ```bash
    pnpm build
    ```

    </details>

5.  Start the app:

    ```bash
    pnpm start
    ```

    You can now access the app on [http://localhost:3000](http://localhost:3000)

6.  For development build:

    -   Create `.env` file and specify the `VITE_PORT` (refer to `.env.example`) in `packages/ui`
    -   Create `.env` file and specify the `PORT` (refer to `.env.example`) in `packages/server`
    -   Run:

        ```bash
        pnpm dev
        ```

    Any code changes will reload the app automatically on [http://localhost:8080](http://localhost:8080)

## 🌱 Env Variables

Flowise supports different environment variables to configure your instance. You can specify the following variables in the `.env` file inside `packages/server` folder. Read [more](https://github.com/FlowiseAI/Flowise/blob/main/CONTRIBUTING.md#-env-variables)

## 📖 Documentation

You can view the Flowise Docs [here](https://docs.flowiseai.com/)

## 🌐 Self Host

Deploy Flowise self-hosted in your existing infrastructure, we support various [deployments](https://docs.flowiseai.com/configuration/deployment)

-   [AWS](https://docs.flowiseai.com/configuration/deployment/aws)
-   [Azure](https://docs.flowiseai.com/configuration/deployment/azure)
-   [Digital Ocean](https://docs.flowiseai.com/configuration/deployment/digital-ocean)
-   [GCP](https://docs.flowiseai.com/configuration/deployment/gcp)
-   [Alibaba Cloud](https://computenest.console.aliyun.com/service/instance/create/default?type=user&ServiceName=Flowise社区版)
-   <details>
      <summary>Others</summary>

    -   [Railway](https://docs.flowiseai.com/configuration/deployment/railway)

        [![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/pn4G8S?referralCode=WVNPD9)

    -   [Northflank](https://northflank.com/stacks/deploy-flowiseai)

        [![Deploy to Northflank](https://assets.northflank.com/deploy_to_northflank_smm_36700fb050.svg)](https://northflank.com/stacks/deploy-flowiseai)

    -   [Render](https://docs.flowiseai.com/configuration/deployment/render)

        [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://docs.flowiseai.com/configuration/deployment/render)

    -   [HuggingFace Spaces](https://docs.flowiseai.com/configuration/deployment/hugging-face)

        <a href="https://huggingface.co/spaces/FlowiseAI/Flowise"><img src="https://huggingface.co/datasets/huggingface/badges/raw/main/open-in-hf-spaces-sm.svg" alt="HuggingFace Spaces"></a>

    -   [Elestio](https://elest.io/open-source/flowiseai)

        [![Deploy on Elestio](https://elest.io/images/logos/deploy-to-elestio-btn.png)](https://elest.io/open-source/flowiseai)

    -   [Sealos](https://template.sealos.io/deploy?templateName=flowise)

        [![Deploy on Sealos](https://sealos.io/Deploy-on-Sealos.svg)](https://template.sealos.io/deploy?templateName=flowise)

    -   [RepoCloud](https://repocloud.io/details/?app_id=29)

        [![Deploy on RepoCloud](https://d16t0pc4846x52.cloudfront.net/deploy.png)](https://repocloud.io/details/?app_id=29)

      </details>

## ☁️ Flowise Cloud

Get Started with [Flowise Cloud](https://flowiseai.com/).

## 🙋 Support

Feel free to ask any questions, raise problems, and request new features in [Discussion](https://github.com/FlowiseAI/Flowise/discussions).

## 🙌 Contributing

Thanks go to these awesome contributors

<a href="https://github.com/FlowiseAI/Flowise/graphs/contributors">
<img src="https://contrib.rocks/image?repo=FlowiseAI/Flowise" />
</a><br><br>

See [Contributing Guide](CONTRIBUTING.md). Reach out to us at [Discord](https://discord.gg/jbaHfsRVBW) if you have any questions or issues.

[![Star History Chart](https://api.star-history.com/svg?repos=FlowiseAI/Flowise&type=Timeline)](https://star-history.com/#FlowiseAI/Flowise&Date)

## 📄 License

All source code in this repository is made available under the
[Apache License Version 2.0](LICENSE.md). There are no exceptions and no commercially licensed
carve-outs.

The 127 files that upstream licensed commercially have been removed and independently
reimplemented under Apache 2.0. Nothing was relicensed. See **[FORK.md](FORK.md)** for the full
breakdown, **[NOTICE](NOTICE)** for attribution, and
**[docs/CLEANROOM-ATTESTATION.md](docs/CLEANROOM-ATTESTATION.md)** for the evidence.
