# Node.js version (overridable via build-arg from CI)
ARG NODE_VERSION=24

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
