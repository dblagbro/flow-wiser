<!-- markdownlint-disable MD030 -->

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
docker pull dblagbro/flow-wiser:3.1.4-fw3     # or :latest
```

```
flowise=3.1.4   flowise-components=3.1.4   connect-sqlite3=0.9.16   vm2=3.11.5
```

Or build it yourself, and watch the assertions fire:

```bash
git clone https://github.com/dblagbro/flow-wiser && cd flow-wiser
docker build --no-cache --pull \
  --build-arg NODE_VERSION=20 \
  --build-arg FLOWISE_VERSION=3.1.4 \
  --build-arg CONNECT_SQLITE3_VERSION=0.9.16 \
  --build-arg VM2_VERSION=3.11.5 \
  -f docker/Dockerfile -t flow-wiser/flowise:3.1.4-fw3 docker/
```

This closes **all 26 advisories published 2026-08-04** (10 critical, 13 high, 3 medium), including `GHSA-8gj2-2cvc-6xx7`, which required 3.1.4 and was previously unreachable because 3.1.4 would not start. It also upgrades **`vm2` 3.11.2 → 3.11.5**, closing six critical sandbox escapes — the RCE primitive that begins *RCE → read `database.sqlite` → decrypt credentials → exfiltrate API keys*.

⚠️ **Licensing:** like every Flowise container, this image contains compiled output from `packages/server/src/enterprise/` and `IdentityManager.ts`, which are under FlowiseAI's **Commercial License**, not Apache 2.0. Their terms govern those components wherever you obtain the image. See [FORK.md](FORK.md). **An Apache-2.0-only build with those components removed is in progress** — see [docs/REQUIREMENTS-AUTH-RBAC.md](docs/REQUIREMENTS-AUTH-RBAC.md).

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
> ### ⚖️ Licensing at a glance — Flowise is *open core*, not wholly open source
>
> | Scope | License | Redistributable? |
> | --- | --- | --- |
> | Everything else | **Apache License 2.0** | ✅ Yes |
> | `packages/server/src/enterprise/` (126 files)<br>`packages/server/src/IdentityManager.ts` | **[FlowiseAI Commercial License](packages/server/src/enterprise/LICENSE.md)** | ❌ **No** — dev/testing only |
>
> The commercial portion is **inert at runtime** unless `FLOWISE_EE_LICENSE_KEY` is set, so running
> this fork in open-source mode exercises none of it. This fork preserves the upstream licensing
> split **exactly as published and relicenses nothing** — your rights and obligations for those 127
> files are identical to obtaining them from upstream, and FlowiseAI's Commercial License governs
> them wherever you get them.
>
> **Removing those files entirely is the project's headline goal** — see
> [docs/REQUIREMENTS-AUTH-RBAC.md](docs/REQUIREMENTS-AUTH-RBAC.md). The repository is currently
> **94.67% Apache 2.0 by file count, 95.58% by lines**; the remaining 5% is one coherent subsystem
> (authentication, SSO, RBAC, multi-tenancy). It cannot simply be deleted — Flowise 3.x removed the
> Apache-2.0 auth it replaced, so dropping it without a replacement yields an unauthenticated
> server. Original Apache-2.0 replacements are being built on the `apache2-only` branch under a
> [clean-room protocol](docs/CLEANROOM-PROTOCOL.md).
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

### Docker Compose

1. Clone the Flowise project
2. Go to `docker` folder at the root of the project
3. Copy `.env.example` file, paste it into the same location, and rename to `.env` file
4. `docker compose up -d`
5. Open [http://localhost:3000](http://localhost:3000)
6. You can bring the containers down by `docker compose stop`

### Docker Image

1. Build the image locally:

    ```bash
    docker build --no-cache -t flowise .
    ```

2. Run image:

    ```bash
    docker run -d --name flowise -p 3000:3000 flowise
    ```

3. Stop image:

    ```bash
    docker stop flowise
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

Source code in this repository is made available under the [Apache License Version 2.0](LICENSE.md),
**with the exception of** `packages/server/src/enterprise/` and `packages/server/src/IdentityManager.ts`,
which are governed by the separate
[FlowiseAI Inc Commercial License](packages/server/src/enterprise/LICENSE.md) and are **not**
open source or freely redistributable.

This fork preserves that upstream licensing split exactly as published and relicenses nothing.
See **[FORK.md](FORK.md)** for the full breakdown and **[NOTICE](NOTICE)** for attribution.
