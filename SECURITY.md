# Security Policy — Flow-Wiser

Upstream Flowise stopped accepting security reports when it was sunset in August 2026.
Its `SECURITY.md` read, verbatim:

> *"we are no longer accepting new security vulnerability reports for this repository."*

Flow-Wiser exists in part to close that gap. **This fork does accept reports.**

---

## Why this matters for Flowise specifically

Flowise has **116 published security advisories** in the GitHub Advisory Database. On
**2026-08-04 alone — the day after the sunset announcement — 26 more were published**:
10 critical, 13 high, 3 medium. Among the criticals were five distinct remote code
execution paths, a sandbox escape, and an unauthenticated OAuth2 token disclosure.

Upstream froze code on 2026-07-29 and the maintainers depart 2026-08-31. Any advisory
published after that has no vendor to route to.

## ⚠️ Known issue: official Docker images ship an unpatched server

Verified 2026-08-05 against the published images:

| Image tag | Server package actually shipped |
| --- | --- |
| `flowiseai/flowise:3.1.2` | `flowise@3.1.2` |
| `flowiseai/flowise:3.1.3` | `flowise@3.1.2` ❌ |
| `flowiseai/flowise:3.1.4` | `flowise@3.1.2` ❌ |

`flowise@3.1.3` and `@3.1.4` **are** published correctly on npm — but no official Docker
image ever contained them.

**Cause:** `docker/Dockerfile` ran an unpinned `npm install -g flowise`. The version was
not part of the Docker layer cache key, so later builds reused the layer produced when
npm's `latest` was still 3.1.2.

**Impact:** the 25 advisories fixed in `flowise@3.1.3` — including critical RCEs — are
**not** applied in any official image. Anyone who "upgraded" to the 3.1.3 or 3.1.4 image
is still running the 3.1.2 server. Check your own instance:

```bash
curl -s http://<your-host>:3000/api/v1/version
docker exec <container> sh -c 'grep -m1 version /usr/local/lib/node_modules/flowise/package.json'
```

If that reports `3.1.2` while you are running a `3.1.3`/`3.1.4` image, you are affected.

**Mitigation:** build with the version pinned. Flow-Wiser's `docker/Dockerfile` takes a
`FLOWISE_VERSION` build argument and **fails the build** if npm resolves anything other
than the requested version:

```bash
docker build --no-cache --pull \
  --build-arg FLOWISE_VERSION=3.1.3 \
  -f docker/Dockerfile -t flow-wiser/flowise:3.1.3 docker/
```

## Reporting a vulnerability

Open a **private security advisory** via
[Security → Report a vulnerability](https://github.com/dblagbro/flow-wiser/security/advisories/new)
on this repository. Please do not open a public issue for an unfixed vulnerability.

Include: affected version, deployment shape (Docker/npm/source), reproduction steps,
and observed vs expected behaviour.

This is a best-effort community project with **no service-level commitment**. Reports
are triaged as maintainer time allows. If you need guaranteed response times, do not
rely on this project alone.

## Scope

**In scope** — the Apache-2.0 licensed code in this repository, the container build, and
dependency vulnerabilities reachable in a default deployment.

**Out of scope** — Flowise Cloud (discontinued), the commercially licensed code under
`packages/server/src/enterprise/` and `packages/server/src/IdentityManager.ts` (see
[FORK.md](FORK.md)), and vulnerabilities in third-party nodes that require attacker-supplied
flows to already be installed by an administrator.

## Hardening notes for operators

- **Do not expose Flowise directly to the internet.** Put it behind a reverse proxy with
  authentication, and bind the container to `127.0.0.1` rather than `0.0.0.0`.
- Several historical RCEs are reachable **pre-authentication**; network exposure is the
  single biggest risk multiplier.
- `FLOWISE_USERNAME` / `FLOWISE_PASSWORD` **no longer do anything** in 3.x. They were
  removed from the server in the 2025-05-27 refactor. If your compose file still sets
  them, they are dead config — your real credentials live in the application database.
- Pin your image version explicitly and verify the installed server version after every
  upgrade, per the table above.

## Upstream advisory archive

A snapshot of all 116 upstream advisories is preserved in
[`upstream-archive/advisories/`](upstream-archive/advisories/), captured before the
upstream repository was archived on 2026-08-10.
