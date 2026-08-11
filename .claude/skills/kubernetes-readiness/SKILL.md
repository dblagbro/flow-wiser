---
name: kubernetes-readiness
description: Assess and improve container, Kubernetes and cloud-deployment readiness — image hygiene, pinning, health and signal handling, configuration and secret management, scaling, observability. Authors and validates manifests; never applies them to a live cluster.
---

# kubernetes-readiness

Assess deployment posture and author what is missing. **Nothing is applied to a live cluster** —
a human does that.

## 1. Start honest about the baseline

This repository currently ships **no Kubernetes manifests, Helm charts or IaC** — only Docker and
compose. That is a coverage limit, not a pass. Say so in every report rather than letting a clean
assessment imply readiness that does not exist.

## 2. Orient

Read `AGENTS.md`, `docs/platform-roadmap.md`, `docker/README.md`, `Dockerfile`,
`docker/Dockerfile`, the compose files, and `docs/testing.md` (INFRA findings).

```bash
cd /mnt/s/code/flow-wiser
ls docker/ && cat .dockerignore
docker compose -f docker/docker-compose.yml config >/dev/null && echo "compose: valid"
```

Use the **platform-engineer** agent if `.claude/agents/platform-engineer.md` exists; the
**security-reviewer** agent for the security dimension. Otherwise inline to the same standard.

## 3. Assess

| Area              | Check                                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Image**         | base pinned (digest where practical); versions passed as build args so they participate in the cache key; **installed-equals-requested assertion present and passing**; multi-stage; no secrets in any layer |
| **Runtime**       | non-root user; **node as PID 1**, not a package manager — pnpm as PID 1 exits non-zero on clean stop and leaves zombies; correct signal handling                                                             |
| **Health**        | `HEALTHCHECK` in the image; liveness _and_ readiness distinguished — readiness must fail while migrations run or the DB is unreachable                                                                       |
| **Config**        | 12-factor env; every required variable documented in `.env.example`; **a missing mandatory secret must be fatal at boot**, never a live-but-unusable server                                                  |
| **Secrets**       | referenced from a secret store, never baked into an image, manifest or ConfigMap; `FLOWISE_SECRETKEY_OVERWRITE` must never be the documented example value                                                   |
| **State**         | which components are stateful; SQLite is single-writer and **does not survive horizontal scaling** — Postgres is required before replicas; volume and backup story                                           |
| **Queues**        | Redis/BullMQ topology, worker deployment, whether the server scales independently of workers                                                                                                                 |
| **Scaling**       | replica safety, session affinity, migration-on-startup races between replicas                                                                                                                                |
| **Networking**    | exposed ports, ingress, TLS, which high-risk `/api/v1/` endpoints must not be publicly reachable                                                                                                             |
| **Observability** | health endpoints, structured logs **without secrets**, metrics, retention, alerting                                                                                                                          |
| **Resources**     | requests/limits, restart policy, PodDisruptionBudget                                                                                                                                                         |

## 4. Author what is missing

Manifests, charts, or compose improvements — as files in the repository. Validate
non-destructively and report exactly what you could not validate:

```bash
docker build -f docker/Dockerfile -t flow-wiser:readiness-check .
docker compose -f docker/docker-compose.yml config
kubectl apply --dry-run=client -f <manifest>   # client-side only
helm template <chart>
hadolint Dockerfile        # if present; report MISSING rather than skipping silently
```

## 5. Absolutely prohibited

-   `kubectl apply/delete/patch`, `helm install/upgrade`, `terraform apply/destroy` — anything
    touching a live cluster or cloud account
-   `docker compose down`, `docker volume rm`, `docker system prune` — this host runs ~113
    unrelated services; target named containers only
-   Deploying, restarting production, pushing an image, publishing to a registry
-   Writing any secret into a Dockerfile, compose file, manifest or ConfigMap

## 6. Record

Update `docs/platform-roadmap.md` with the assessment, the gaps, and a prioritised path.
Add an ADR for topology decisions (for example, requiring Postgres before horizontal scaling).
Log infrastructure defects in `docs/bug-log.md`.

## 7. Report

```
KUBERNETES READINESS — <date>
Baseline    <what exists: docker/compose/k8s/IaC>
Assessment  <area: READY | GAP — one line each>
Authored    <files created + validation result>
Not validated  <what, and why — missing tool, needs a cluster>
Blockers to production  <ordered>
Operator actions  <what only a human can apply>

STATUS: PASS | FAIL — <n> gaps | BLOCKED — <need> | REVIEW REQUIRED — <decision>
```
