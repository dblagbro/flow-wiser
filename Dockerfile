# Build the monorepo from source.
#
#   docker build --no-cache --pull \
#     --build-arg NODE_VERSION=20 \
#     --build-arg FLOWISE_VERSION=3.1.4-fw8 \
#     -t dblagbro/flow-wiser:3.1.4-fw4 .
#
#   docker run -d -p 3000:3000 dblagbro/flow-wiser:3.1.4-fw4
#
# THIS is the Dockerfile that produces an Apache-2.0-only image. It compiles the
# tree in this repository, from which the 127 commercially licensed files have
# been deleted, so nothing derived from them can reach the image.
#
# docker/Dockerfile does NOT produce an Apache-2.0-only image and cannot. It runs
# `npm install -g flowise@<version>`, which fetches FlowiseAI's published package
# -- and that package ships the compiled `dist/enterprise/` output and
# `dist/IdentityManager.js` under the FlowiseAI Commercial License. That is how
# 3.1.4-fw1 through 3.1.4-fw3 came to contain commercially licensed material.
# It is kept for reproducing and diagnosing the upstream images, not for
# publishing ours.

# Node 20, not 24. better-sqlite3 fails to compile under node-gyp on Node 24
# ("gyp ERR! not ok", node-gyp 8.4.1), and every published flowiseai/flowise image
# actually runs v20.20.2 -- so the 24 here could never have produced a working build.
# Same defect as docker/Dockerfile's ARG NODE_VERSION=24, fixed there in an earlier commit.
ARG NODE_VERSION=20
FROM node:${NODE_VERSION}-alpine

# Install system dependencies and build tools
RUN apk update && \
    apk add --no-cache \
    libc6-compat \
    python3 \
    make \
    g++ \
    build-base \
    cairo-dev \
    pango-dev \
    chromium \
    curl && \
    npm install -g pnpm@10.26.0

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

ENV NODE_OPTIONS=--max-old-space-size=8192

WORKDIR /usr/src/flowise

# Copy app source
COPY . .

# Assert the tree is the version this build claims to be.
#
# The version the server reports comes from packages/server/package.json -- the
# version service walks up from dist/services/versions to the nearest
# package.json. Passing FLOWISE_VERSION makes the tag and the reported version
# one fact instead of two, and fails the build rather than shipping an image
# whose tag disagrees with its contents. That mismatch is the exact defect this
# fork was started to fix, so it is worth a hard gate on our own builds too.
#
# Left empty by default so a plain `docker build .` still works.
ARG FLOWISE_VERSION=
RUN if [ -n "${FLOWISE_VERSION}" ]; then \
      DECLARED="$(node -p "require('./packages/server/package.json').version")" \
      && echo "requested=${FLOWISE_VERSION} declared=${DECLARED}" \
      && if [ "${DECLARED}" != "${FLOWISE_VERSION}" ]; then \
           echo "FATAL: requested ${FLOWISE_VERSION} but the tree declares ${DECLARED}" >&2; exit 1; \
         fi; \
    fi

# Install dependencies and build (excluding sdk packages not needed for Docker)
RUN pnpm install && \
    pnpm build:docker

# Final gate: the build output must contain no commercially licensed material.
#
# The 127 files are deleted from the source tree, but `pnpm install` pulls
# packages from npm, and upstream's published `flowise` package contains the
# compiled enterprise output. If any dependency ever drags a copy in, this build
# stops here rather than publishing an image the repository's Apache-2.0 claim
# does not cover.
#
# `upstream-archive` is named explicitly because it is the way this went wrong
# once already: 15 of the 347 archived community pull requests carry diff hunks
# against packages/server/src/enterprise/ and IdentityManager.ts -- that is what
# those PRs changed -- and `COPY . .` put them in the image. It is excluded in
# .dockerignore; this asserts the exclusion held.
RUN FOUND="$(find / -xdev \( -path '*/enterprise/*' -o -name 'IdentityManager.*' -o -name 'upstream-archive' \) -print 2>/dev/null)" \
    && if [ -n "${FOUND}" ]; then \
         echo "FATAL: commercially licensed artifacts present in the image:" >&2; \
         echo "${FOUND}" >&2; exit 1; \
       fi \
    && echo "CLEAN: no enterprise/ path, no IdentityManager artifact, no upstream-archive anywhere in the image"

# Put `flowise` on PATH.
#
# Every recovery message the server and CLI print names `flowise` -- "create the
# first administrator with: flowise admin:create --email <you> --role
# super-admin" is logged on the first boot of every new instance. pnpm links the
# workspace bin into node_modules/.bin, but nothing put that directory on PATH,
# so `docker exec <container> flowise admin:create` answered "not found" and the
# operator had to know the layout of the image to get in. The commands we print
# have to be the commands that run.
ENV PATH=/usr/src/flowise/node_modules/.bin:$PATH

# Give the node user ownership of the application files
RUN chown -R node:node .

# The bin has to work, not just exist.
RUN cd / && flowise --version

# Switch to non-root user (node user already exists in node:20-alpine)
USER node

EXPOSE 3000

CMD [ "pnpm", "start" ]
