# Build local monorepo image
# docker build --no-cache -t  flowise .

# Run image
# docker run -d -p 3000:3000 flowise

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

# Install dependencies and build (excluding sdk packages not needed for Docker)
RUN pnpm install && \
    pnpm build:docker

# Give the node user ownership of the application files
RUN chown -R node:node .

# Switch to non-root user (node user already exists in node:20-alpine)
USER node

EXPOSE 3000

CMD [ "pnpm", "start" ]
