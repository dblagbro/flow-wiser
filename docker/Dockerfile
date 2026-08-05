# Node.js version (overridable via build-arg from CI)
#
# Upstream defaulted this to 24, but that default does not build: better-sqlite3
# fails to compile under node-gyp on Node 24 ("gyp ERR! not ok", node-gyp 8.4.1).
# Every published flowiseai/flowise image (3.1.2, 3.1.3, 3.1.4) actually runs
# Node v20.20.2, so upstream CI must have been overriding this. Defaulting to 20
# makes a plain `docker build` reproduce the shipped runtime instead of failing.
ARG NODE_VERSION=20

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
RUN npm --prefix "$(npm root -g)/flowise" install --no-save \
      "connect-sqlite3@${CONNECT_SQLITE3_VERSION}" \
    && PINNED="$(node -p "require('/usr/local/lib/node_modules/flowise/node_modules/connect-sqlite3/package.json').version")" \
    && echo "connect-sqlite3 pinned to ${PINNED}" \
    && if [ "${PINNED}" != "${CONNECT_SQLITE3_VERSION}" ]; then \
         echo "FATAL: connect-sqlite3 pin failed, got ${PINNED}" >&2; exit 1; \
       fi

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
