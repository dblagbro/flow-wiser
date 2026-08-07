# Publishing `3.1.4-fw4` — staged, not run

Nothing here has been executed. No tag exists, no GitHub release exists, and nothing has
been pushed to Docker Hub. Run these in order when you are ready.

Everything below assumes the release commit is the head of `wip/release`.

---

## 0. Merge to the release branch and confirm CI

```bash
git fetch origin
git checkout apache2-only
git merge --ff-only origin/wip/release
git push origin apache2-only
```

Then wait for the `cleanroom-guard` and `proprietary-path-guard` workflows to pass — they
are the ones that matter for this release.

## 1. Tag

```bash
git tag -a v3.1.4-fw4 -m "Flow-Wiser 3.1.4-fw4 — Apache-2.0-only, with identity, RBAC and multi-tenancy"
git push origin v3.1.4-fw4
```

Verify:

```bash
git ls-remote --tags origin | grep v3.1.4-fw4
```

## 2. Build the release image

From the **root** `Dockerfile`. Note the `.` context and the absence of `-f`.

```bash
docker build --no-cache --pull \
  --build-arg NODE_VERSION=20 \
  --build-arg FLOWISE_VERSION=3.1.4-fw4 \
  -t dblagbro/flow-wiser:3.1.4-fw4 .
```

Three gates fire during this build and all three must appear in the output:

```
requested=3.1.4-fw4 declared=3.1.4-fw4
CLEAN: no enterprise/ path, no IdentityManager artifact, no upstream-archive anywhere in the image
flowise/3.1.4-fw4 linux-x64 node-v20.20.2
```

`--no-cache` is not optional. The bug this fork exists to fix was a cached layer.

## 3. Smoke-test the image you are about to push

```bash
docker rm -f fw4-smoke 2>/dev/null; docker volume rm fw4-smoke-data 2>/dev/null
docker volume create fw4-smoke-data

docker run -d --name fw4-smoke --user root -p 13000:3000 \
  -e DATABASE_TYPE=sqlite -e DATABASE_PATH=/data \
  -e SECRETKEY_OVERWRITE="$(openssl rand -base64 32)" \
  -e FLOWISE_SECRETKEY_OVERWRITE="$(openssl rand -base64 32)" \
  -e IDENTITY_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  -e FLOWISE_SESSION_PEPPER="$(openssl rand -base64 32)" \
  -v fw4-smoke-data:/data dblagbro/flow-wiser:3.1.4-fw4

sleep 45
docker logs fw4-smoke 2>&1 | grep -c '\[ERROR\]'                  # expect 0
curl -s -H 'x-request-from: internal' localhost:13000/api/v1/version   # expect {"version":"3.1.4-fw4"}
docker exec -it fw4-smoke flowise admin:create --email you@example.com --role super-admin
docker rm -f fw4-smoke && docker volume rm fw4-smoke-data
```

## 4. Tag and push to Docker Hub

```bash
docker login

docker push dblagbro/flow-wiser:3.1.4-fw4

docker tag dblagbro/flow-wiser:3.1.4-fw4 dblagbro/flow-wiser:latest
docker push dblagbro/flow-wiser:latest
```

**`:latest` currently points at `3.1.4-fw3`, which contains commercially licensed
compiled output.** Moving it is the point of this release, not an afterthought.

## 5. Verify what is actually on Docker Hub

Pull it back by digest on a machine that has never built it, so you are testing the
registry rather than your local cache.

```bash
docker rmi dblagbro/flow-wiser:3.1.4-fw4 dblagbro/flow-wiser:latest
docker pull dblagbro/flow-wiser:3.1.4-fw4

docker run -d --name fw4-verify --user root -p 13000:3000 \
  -e DATABASE_TYPE=sqlite -e DATABASE_PATH=/data \
  -e SECRETKEY_OVERWRITE="$(openssl rand -base64 32)" \
  -e FLOWISE_SECRETKEY_OVERWRITE="$(openssl rand -base64 32)" \
  -e IDENTITY_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  -e FLOWISE_SESSION_PEPPER="$(openssl rand -base64 32)" \
  dblagbro/flow-wiser:3.1.4-fw4

sleep 45

# The version the published image reports
curl -s -H 'x-request-from: internal' http://localhost:13000/api/v1/version
# -> {"version":"3.1.4-fw4"}

# :latest must report the same thing
docker pull dblagbro/flow-wiser:latest
docker run --rm --entrypoint node dblagbro/flow-wiser:latest \
  -p "require('/usr/src/flowise/packages/server/package.json').version"
# -> 3.1.4-fw4

# And the published image must still be clean
docker run --rm --entrypoint sh dblagbro/flow-wiser:3.1.4-fw4 -c \
  "find / -xdev \( -path '*/enterprise/*' -o -name 'IdentityManager.*' -o -name 'upstream-archive' \) | wc -l"
# -> 0

docker rm -f fw4-verify
```

## 6. GitHub release

The notes are already written: [`docs/RELEASE-NOTES-3.1.4-fw4.md`](RELEASE-NOTES-3.1.4-fw4.md).

```bash
gh release create v3.1.4-fw4 \
  --title "3.1.4-fw4 — Flowise, actually open source" \
  --notes-file docs/RELEASE-NOTES-3.1.4-fw4.md \
  --latest
```

## 7. After publishing

- Mark `v3.1.4-fw1` and `v3.1.4-fw3` as superseded on their GitHub release pages. They are
  not redistributable, and the release pages are where someone will look.
- Consider whether the `3.1.4-fw1`–`fw3` **tags on Docker Hub** should be removed rather
  than left pullable. Leaving them is defensible — they are what people are running, and
  deleting an image somebody depends on is its own harm — but leaving them silently is not.
  Whatever you choose, the Docker Hub description should say which tags are redistributable.
- The Docker Hub repository description still refers to `3.1.4-fw3`.

## Do not use

```bash
# WRONG. Builds from FlowiseAI's npm package, which carries the commercially
# licensed compiled output. This is how fw1-fw3 came to contain it.
docker build -f docker/Dockerfile ... docker/
```

and the `Docker Image CI - Docker Hub` GitHub Actions workflow, which builds that same
Dockerfile and pushes to `flowiseai/flowise`. Both carry warnings in the files themselves.
