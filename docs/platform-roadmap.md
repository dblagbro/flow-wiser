# Platform roadmap

**Last updated: 2026-08-11** · **Assessed at:** `apache2-only` @ `ffae9952`

Container, orchestration, cloud and observability posture. Maintained by the
`kubernetes-readiness` skill.

## Baseline — state it plainly

This repository ships **Docker and Compose only**. There are **no Kubernetes manifests, no Helm
charts, no Terraform, no IaC of any kind**. That is a coverage limit, not a clean bill of health;
any assessment that reads as "no findings" must say this first.

| Artifact                                                   | Present                          |
| ---------------------------------------------------------- | -------------------------------- |
| `Dockerfile`, `docker/Dockerfile`, `docker/worker/`        | ✅                               |
| `docker/docker-compose.yml`                                | ✅ single-node                   |
| `docker/docker-compose-queue-source.yml` / `-prebuilt.yml` | ✅ queue mode                    |
| GitHub Actions (11 workflows)                              | ✅ incl. `test_docker_build.yml` |
| Kubernetes / Helm / Terraform                              | ❌ **none**                      |

## What is already right — do not regress it

These were bought with real incidents. Removing any of them re-opens a defect this project
already paid for.

-   **Version pinning as a build arg**, so it participates in the Docker layer cache key. An
    unpinned `npm install -g flowise` froze three published images at the wrong server version
    because the layer text never changed.
-   **An installed-equals-requested assertion** that fails the build loudly. Caching bugs are
    silent; a stale-but-working install is indistinguishable from a fresh one.
-   **Pins applied in a single install with a final gate after all mutations.** Per-step assertions
    cannot catch a later step reverting an earlier one — `3.1.4-fw2` was built and discarded for
    exactly that.
-   **`node` as PID 1**, not a package manager — pnpm as PID 1 exits non-zero on clean stop and
    leaves zombies unreaped.
-   **A `HEALTHCHECK`** on `/api/v1/ping`.
-   **Missing mandatory secrets are fatal at boot.** A live-but-unusable server is worse than a
    failed start.
-   **`.dockerignore` excludes `upstream-archive/`** — it must never enter an image layer.

## Gaps, prioritised

### P1 — blocks any cluster deployment

| Gap                                   | Why it matters                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **SQLite cannot scale horizontally**  | single-writer. Postgres is a hard precondition for replicas — this is a topology decision, not a tuning one |
| **Migration-on-startup races**        | concurrent replicas running migrations simultaneously is unsafe; needs a job or a lock                      |
| **No readiness/liveness distinction** | readiness must fail while migrations run or the DB is unreachable; a single healthcheck cannot express that |
| **No manifests at all**               | nothing to review, apply or validate                                                                        |

### P2 — production hardening

| Gap                                        | Action                                                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Secret management                          | reference a secret store; never bake into image, manifest or ConfigMap. `FLOWISE_SECRETKEY_OVERWRITE` must never be the documented example value |
| Ingress and exposure                       | the full `/api/v1/` surface has been publicly proxied before; high-risk endpoints need an allowlist at the edge                                  |
| Resource requests/limits, PDB              | absent                                                                                                                                           |
| Session affinity / replica safety          | unassessed                                                                                                                                       |
| Backup and restore for stateful components | see [`backup-plan.md`](backup-plan.md)                                                                                                           |

### P3 — observability

| Gap                    | Action                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| Metrics                | `packages/server/src/metrics/` and `@flowiseai/observe` exist; the deployment story does not |
| Structured logs        | confirm no secrets or credential material reach logs                                         |
| Retention and alerting | undefined                                                                                    |
| Trace/correlation IDs  | unassessed                                                                                   |

### P4 — tooling not available on this machine

`hadolint`, `trivy` and `shellcheck` are absent, so image and shell linting cannot run.
See RM-09 in [`remediation-plan.md`](remediation-plan.md).

## Sequence

1. Resolve the Node version question (RM-02) — everything downstream builds on it.
2. Restore a runnable toolchain (RM-01) so `docker build` and the test suite can be verified.
3. Decide the persistence topology: **Postgres before any replica.** Record as an ADR.
4. Split migrations out of startup into an explicit job or lock.
5. Add readiness separate from liveness.
6. Author manifests/chart; validate client-side only (`--dry-run=client`, `helm template`).
7. Add secret management and ingress allowlisting.
8. Add observability and resource policy.
9. Run `kubernetes-readiness` end to end and record the result here.

## Rules

-   **Never apply to a live cluster or cloud account.** Author and validate; a human applies.
-   **Never** `docker compose down`, `docker volume rm`, or `docker system prune` — this host runs
    ~113 unrelated services. Named containers only.
-   Never write a secret into a Dockerfile, compose file, manifest or ConfigMap.
-   Anything that participates in a cache key gets pinned, and the pin gets asserted **after** all
    mutations.
