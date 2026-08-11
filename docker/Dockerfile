# ---------------------------------------------------------------------------
# NOT the Dockerfile that builds a Flow-Wiser release. Use the one at the
# repository root.
#
# This file installs FlowiseAI's published npm package. That package contains
# the compiled `dist/enterprise/` output and `dist/IdentityManager.js`, which are
# under the FlowiseAI Commercial License and cannot be redistributed. Every image
# built from this file therefore carries commercially licensed material,
# regardless of what has been deleted from this repository -- which is exactly
# how 3.1.4-fw1 through 3.1.4-fw3 came to.
#
# It is retained because it documents and reproduces three real upstream
# container defects (below), and because it is the only way to build an image of
# an upstream release for comparison. It also cannot build 3.1.4-fw4 or anything
# later: those versions exist only in this repository, never on npm, so
# FLOWISE_VERSION has no value here that would produce a Flow-Wiser release.
#
# The Apache-2.0-only image is built from source:
#
#   docker build --no-cache --pull \
#     --build-arg NODE_VERSION=22 \
#     --build-arg FLOWISE_VERSION=3.1.4-fw10 \
#     -t dblagbro/flow-wiser:3.1.4-fw4 .
# ---------------------------------------------------------------------------

# Node.js version (overridable via build-arg from CI)
#
# Node 22 is the supported version for this project. See
# docs/decisions/ADR-0004-node-version-conflict.md (Accepted 2026-08-11).
#
# History: upstream defaulted this to 24, but that default does not build --
# better-sqlite3 fails to compile under node-gyp on Node 24 ("gyp ERR! not ok",
# node-gyp 8.4.1). Every published flowiseai/flowise image (3.1.2, 3.1.3, 3.1.4)
# actually ran Node v20.20.2, so upstream CI must have been overriding this. The
# default was set to 20 to reproduce the shipped runtime; Node 20 is now near end
# of support, so the project standardised on 22.
#
# This value must stay in step with .nvmrc, `engines.node`, and the CI Node matrix.
ARG NODE_VERSION=22

# Stage 1: Build stage
FROM node:${NODE_VERSION}-alpine AS build

USER root

# Install build dependencies
RUN apk add --no-cache git python3 py3-pip make g++ build-base cairo-dev pango-dev

# Skip downloading Chrome for Puppeteer (saves build time)
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Install Flowise globally, PINNED to an explicit version.
#
# Upstream used an unpinned `npm install -g flowise` here. Because that layer is
# cacheable and the version is not part of the layer key, Docker reused the layer
# built when npm's `latest` was 3.1.2 -- so the published flowiseai/flowise:3.1.3
# and :3.1.4 images BOTH shipped the flowise@3.1.2 server package, silently
# omitting every server-side security fix released in 3.1.3. Verified 2026-08-05:
#   image 3.1.2 -> flowise@3.1.2
#   image 3.1.3 -> flowise@3.1.2   (should be 3.1.3)
#   image 3.1.4 -> flowise@3.1.2   (should be 3.1.4)
# Making the version an explicit build arg puts it in the layer key, so the
# install layer invalidates whenever the requested version changes.
ARG FLOWISE_VERSION=latest

# npm dedupe is required after install: npm's overrides resolver does not
# consistently collapse every duplicate of an overridden package in one pass
# on a tree this size/complexity
RUN npm install -g "flowise@${FLOWISE_VERSION}" \
    && npm --prefix "$(npm root -g)/flowise" dedupe \
    && INSTALLED="$(node -p "require('/usr/local/lib/node_modules/flowise/package.json').version")" \
    && echo "requested=${FLOWISE_VERSION} installed=${INSTALLED}" \
    && if [ "${FLOWISE_VERSION}" != "latest" ] && [ "${INSTALLED}" != "${FLOWISE_VERSION}" ]; then \
         echo "FATAL: requested flowise@${FLOWISE_VERSION} but installed ${INSTALLED}" >&2; exit 1; \
       fi

# Pin connect-sqlite3.
#
# THIS IS THE ROOT CAUSE OF UPSTREAM ISSUE #6688 ("3.1.4 fails to start").
# connect-sqlite3@0.9.17 changed its constructor so that `this.db.exec` is no
# longer a function, which makes session-store setup throw during startup:
#
#   TypeError: this.db.exec is not a function
#     at new SQLiteStore (connect-sqlite3/lib/connect-sqlite3.js:56:17)
#     at initializeDBClientAndStore (dist/enterprise/middleware/passport/SessionPersistance.js:96)
#
# This is NOT specific to Flowise 3.1.4. Because the dependency is unpinned, ANY
# Flowise image built after 0.9.17 was published crashes on boot -- including a
# freshly built 3.1.3. Verified 2026-08-05:
#   official flowiseai/flowise:3.1.3 (built earlier) -> connect-sqlite3 0.9.16 -> boots
#   fresh build of the same flowise@3.1.3 today      -> connect-sqlite3 0.9.17 -> crashes
#
# 0.9.16 is the last version with the working constructor and is what every
# functioning official image actually shipped. Upstream PR #6706 fixes this in
# the TypeScript source; this pin fixes it for npm-installed container builds.
ARG CONNECT_SQLITE3_VERSION=0.9.16

# Pin vm2 -- SIX CRITICAL SANDBOX ESCAPES in the shipped version.
#
# vm2 is the JavaScript sandbox used by flowise-components for custom-code
# execution (flowise-components/dist/src/utils.js). The published images resolve
# vm2 3.11.2, which is vulnerable to all of the following:
#
#   GHSA-248r-7h7q-cr24  sandbox breakout via async generator      (fixed 3.11.3)
#   GHSA-6j2x-vhqr-qr7q  escape via JSPI-backed Promise .finally   (fixed 3.11.4)
#   GHSA-76w7-j9cq-rx2j  breakout through proxy                    (fixed 3.11.4)
#   GHSA-m4wx-m65x-ghrr  CVE-2023-37903 patch bypass               (fixed 3.11.4)
#   GHSA-rp36-8xq3-r6c4  NodeVM builtin denylist bypass via process(fixed 3.11.4)
#   GHSA-v6mx-mf47-r5wg  sandbox escape                            (fixed 3.11.4)
#
# A sandbox escape here is a remote code execution primitive: it is the first
# link in the chain RCE -> read database.sqlite -> decrypt stored credentials ->
# exfiltrate provider API keys. Patching Flowise itself does NOT close this,
# because vm2 is a transitive dependency and its version is not pinned anywhere.
#
# 3.11.5 is the current published release and is not deprecated.
#
# Longer term vm2 should be replaced outright (isolated-vm), or custom-code
# nodes disabled on internet-facing deployments. vm2 has produced a fresh escape
# in essentially every release line, so pinning is mitigation, not a fix.
ARG VM2_VERSION=3.11.5

# Apply BOTH security pins in a SINGLE npm install, then assert at the very end.
#
# These must not be separate RUN steps. npm re-resolves the dependency tree on
# every install, so a later `npm install vm2@x` silently reverts an earlier
# connect-sqlite3 pin. That exact regression shipped in 3.1.4-fw2: the build
# printed "connect-sqlite3 pinned to 0.9.16" and its assertion passed, but the
# subsequent vm2 install pulled connect-sqlite3 back to 0.9.17 -- the version
# that crashes on boot. Per-step assertions cannot catch this; only a final
# verification after ALL mutations can.
RUN npm --prefix "$(npm root -g)/flowise" install --no-save \
      "connect-sqlite3@${CONNECT_SQLITE3_VERSION}" \
      "vm2@${VM2_VERSION}"

# Final gate. Runs after every package mutation is complete.
RUN M=/usr/local/lib/node_modules/flowise \
    && FV="$(node -p "require('$M/package.json').version")" \
    && CS="$(node -p "require('$M/node_modules/connect-sqlite3/package.json').version")" \
    && VM="$(node -p "require('$M/node_modules/vm2/package.json').version")" \
    && echo "FINAL: flowise=${FV} connect-sqlite3=${CS} vm2=${VM}" \
    && FAIL=0 \
    && if [ "${FLOWISE_VERSION}" != "latest" ] && [ "${FV}" != "${FLOWISE_VERSION}" ]; then \
         echo "FATAL: flowise ${FV} != requested ${FLOWISE_VERSION}" >&2; FAIL=1; fi \
    && if [ "${CS}" != "${CONNECT_SQLITE3_VERSION}" ]; then \
         echo "FATAL: connect-sqlite3 ${CS} != requested ${CONNECT_SQLITE3_VERSION}" >&2; FAIL=1; fi \
    && if [ "${VM}" != "${VM2_VERSION}" ]; then \
         echo "FATAL: vm2 ${VM} != requested ${VM2_VERSION}" >&2; FAIL=1; fi \
    && [ "$FAIL" = "0" ]

# Stage 2: Runtime stage
FROM node:${NODE_VERSION}-alpine

# Install runtime dependencies
RUN apk add --no-cache chromium git python3 py3-pip make g++ build-base cairo-dev pango-dev curl

# Set the environment variable for Puppeteer to find Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Copy Flowise from the build stage
COPY --from=build /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=build /usr/local/bin /usr/local/bin

# Give the node user ownership of the installed package (node:*-alpine already has this user)
RUN chown -R node:node /usr/local/lib/node_modules /usr/local/bin

# Switch to non-root user
USER node

ENTRYPOINT ["flowise", "start"]
