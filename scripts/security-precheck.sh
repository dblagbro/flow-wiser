#!/usr/bin/env bash
# security-precheck.sh — a fast, repeatable "are we still safe?" self-audit for Flow-Wiser.
# Focus: the RCE / credential / supply-chain surface this project has actually been attacked on.
# Read-only. Prints PASS / WARN / FAIL per check; exits non-zero if any FAIL. Run it anytime,
# especially before a release or after a dependency wave.
#
#   ./scripts/security-precheck.sh            # code + deps + secrets checks
#   CHECK_PROD=1 ./scripts/security-precheck.sh   # also check the live production container
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2
PASS=0; WARN=0; FAIL=0
ok(){ printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
warn(){ printf '  \033[33mWARN\033[0m %s\n' "$1"; WARN=$((WARN+1)); }
bad(){ printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
has(){ command -v "$1" >/dev/null 2>&1; }

echo "== 1. Code-execution / RCE controls =="
grep -qE "CODE_EXECUTION_MODE=.*disabled" docker/docker-compose.yml 2>/dev/null && ok "compose template defaults code-exec disabled" || warn "code-exec not disabled in the committed compose template (operator sets it)"
grep -rq "deniedBuiltInDep\|DANGEROUS_BUILTIN" packages/components/src/utils.ts && ok "require allowlist denies host builtins (fs/child_process/process)" || bad "require denylist for host builtins MISSING"
grep -q "node:" packages/components/src/utils.ts && grep -q "replace(/^node:/" packages/components/src/utils.ts && ok "node:-prefix denylist bypass closed (N3)" || warn "could not confirm node:-prefix canonicalization"
grep -q "Proxy: undefined" packages/components/src/utils.ts && grep -q "Reflect: undefined" packages/components/src/utils.ts && ok "vm2 escape primitives (Proxy/Reflect) shadowed" || warn "Proxy/Reflect not confirmed shadowed"
# new exec sinks reachable from HTTP layer (heuristic)
SINK=$(grep -rnE "\beval\(|new Function\(|child_process|execSync\(|\.exec\(|spawn\(" packages/server/src/routes packages/server/src/controllers --include=*.ts 2>/dev/null | grep -vE 'RegExp|\.exec\(|//|\*' | wc -l)
[ "${SINK:-0}" -eq 0 ] && ok "no eval/Function/child_process sinks in routes or controllers" || warn "$SINK possible exec sink(s) under routes/controllers — review"

echo "== 2. Credential / SSRF controls =="
grep -q "credentialAccessibleToWorkspace" packages/components/src/utils.ts && ok "credential decrypt is workspace-scoped (SEC-B-12)" || bad "SEC-B-12 credential workspace guard MISSING"
grep -rq "dns.lookup" packages/components/src/httpSecurity.ts && grep -q "maxRedirects\|redirect" packages/components/src/httpSecurity.ts && ok "SSRF guard: DNS-rebind + redirect revalidation present" || warn "SSRF guard not fully confirmed"
grep -q "secret/credential artifacts" Dockerfile && ok "Dockerfile secret gate present (blocks baking secrets)" || bad "Dockerfile secret gate MISSING"

echo "== 3. Secret hygiene =="
if has git; then
  BAD=$(git ls-files 2>/dev/null | grep -iE 'credentials-backup|secrets-sealed|\.sqlite3?$|(^|/)\.env$|\.pem$|\.key$|\.p12$|id_(rsa|dsa|ecdsa|ed25519)$|service-account.*\.json$' | grep -vE '\.env\.example$' || true)
  [ -z "$BAD" ] && ok "no secret-shaped files tracked in git" || { bad "secret-shaped files tracked:"; echo "$BAD" | sed 's/^/        /'; }
fi
for f in .gitignore .dockerignore .prettierignore; do
  grep -q 'secrets-sealed-' "$f" 2>/dev/null && grep -q 'credentials-backup' "$f" 2>/dev/null && ok "$f carries secret patterns" || warn "$f missing a secret pattern (keep ignore lists in step)"
done

echo "== 4. Dependency exposure (pinned overrides vs current advisories) =="
if has gh && gh auth status >/dev/null 2>&1; then
  REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)"
  CRIT=$(gh api "repos/$REPO/dependabot/alerts" --paginate -q '[.[]|select(.state=="open" and .security_advisory.severity=="critical")]|length' 2>/dev/null | paste -sd+ | bc 2>/dev/null || echo "?")
  HIGH=$(gh api "repos/$REPO/dependabot/alerts" --paginate -q '[.[]|select(.state=="open" and .security_advisory.severity=="high")]|length' 2>/dev/null | paste -sd+ | bc 2>/dev/null || echo "?")
  echo "  open alerts (default branch): critical=$CRIT high=$HIGH"
  # KEY CHECK: is a security-pinned override still resolving BELOW the latest fix?
  if has node && [ -f pnpm-lock.yaml ]; then
    for pkg in axios vm2 multer; do
      res=$(grep -oE "^  ${pkg}@[0-9][0-9A-Za-z.+-]*:" pnpm-lock.yaml 2>/dev/null | sed -E "s#^  ${pkg}@##; s#:##" | sort -uV | tail -1)
      fix=$(gh api "repos/$REPO/dependabot/alerts" --paginate -q ".[]|select(.state==\"open\" and .dependency.package.name==\"$pkg\")|.security_vulnerability.first_patched_version.identifier" 2>/dev/null | tr -d '\"' | grep -vE '^$|^null$' | sort -V | tail -1)
      if [ -z "$res" ]; then warn "$pkg not resolved in lockfile"; continue; fi
      if [ -z "$fix" ]; then ok "$pkg resolved $res (no open alert citing a fix)"; continue; fi
      newest=$(printf '%s\n%s\n' "$res" "$fix" | sort -V | tail -1)
      if [ "$newest" = "$res" ]; then ok "$pkg resolved $res >= latest fix $fix"; else bad "$pkg resolved $res is BELOW current advisory fix $fix — bump the override"; fi
    done
  fi
else
  warn "gh not authenticated — skipped live dependabot comparison (run 'gh auth login')"
fi

echo "== 5. Production posture (CHECK_PROD=1) =="
if [ "${CHECK_PROD:-0}" = "1" ] && has docker; then
  img=$(docker ps --filter name=flowise --format '{{.Image}}' 2>/dev/null)
  [ -n "$img" ] && ok "flowise container running: $img" || warn "flowise container not found"
  docker inspect flowise --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep -q '^CODE_EXECUTION_MODE=disabled' && ok "prod code execution DISABLED" || bad "prod CODE_EXECUTION_MODE is not disabled"
  docker inspect flowise --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep -q '^TRUST_PROXY=' && ok "prod TRUST_PROXY set" || warn "prod TRUST_PROXY unset (rate-limit bypass risk)"
  [ "$(docker inspect flowise --format '{{.State.Health.Status}}' 2>/dev/null)" = healthy ] && ok "prod container healthy" || warn "prod container not healthy"
else
  echo "  (skipped — set CHECK_PROD=1 on the host to include live checks)"
fi

echo
echo "== summary: $PASS pass, $WARN warn, $FAIL fail =="
[ "$FAIL" -eq 0 ]
