# Node.js version (overridable via build-arg from CI)
#
# Node 22 is the supported version for this project. See
# docs/decisions/ADR-0004-node-version-conflict.md (Accepted 2026-08-11).
#
# This was previously a hardcoded `FROM node:24-alpine` with no build arg, so it
# could not be overridden from CI the way the other two Dockerfiles could -- and
# Node 24 cannot compile better-sqlite3 under node-gyp ("gyp ERR! not ok").
# The worker image therefore could not build at all. Made overridable and aligned.
#
# This value must stay in step with .nvmrc, `engines.node`, and the CI Node matrix.
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-alpine

RUN apk add --update libc6-compat python3 make g++
# needed for pdfjs-dist
RUN apk add --no-cache build-base cairo-dev pango-dev

# Install Chromium and curl for container-level health checks
RUN apk add --no-cache chromium curl

#install PNPM globally
RUN npm install -g pnpm@10.26.0

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

ENV NODE_OPTIONS=--max-old-space-size=8192

WORKDIR /usr/src

# Copy app source
COPY . .

RUN pnpm install

RUN pnpm build

# --- Healthcheck Setup ---

WORKDIR /app/healthcheck

COPY docker/worker/healthcheck/package.json . 

RUN npm install --omit=dev

COPY docker/worker/healthcheck/healthcheck.js .

# --- End Healthcheck Setup ---

# Set the main working directory back
WORKDIR /usr/src

# Environment variables for port configuration
ENV WORKER_PORT=5566

# Expose port (can be overridden by env var)
EXPOSE ${WORKER_PORT}

# Give the node user ownership of the application files (node:*-alpine already has this user)
RUN chown -R node:node /usr/src /app

# Switch to non-root user
USER node

# Start healthcheck in background and flowise worker in foreground
CMD ["/bin/sh", "-c", "node /app/healthcheck/healthcheck.js & sleep 5 && pnpm run start-worker"]
