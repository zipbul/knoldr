#!/bin/sh
# Idempotent Knoldr backend bring-up for Claude Code SessionStart.
#
# The 24/7 backend (Postgres + SearXNG + the app's MCP server + 13
# background workers) is owned by docker compose, NOT by the client
# session. `docker compose up -d --wait` is a no-op when the stack is
# already current, so this is safe to run on every session start. There
# is deliberately NO SessionEnd teardown — the workers must outlive the
# session (restart: unless-stopped keeps them up across reboots).
set -e

PROJECT_DIR="${CLAUDE_PLUGIN_ROOT:-.}"
URL="${KNOLDR_URL:-http://localhost:5100}"

# Prerequisites the plugin cannot provision — fail fast with a clear hint.
command -v docker >/dev/null 2>&1 || { echo "knoldr: Docker is required but not found on PATH." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "knoldr: Docker Compose v2 ('docker compose') is required." >&2; exit 1; }

# Idempotent bring-up. --wait blocks on the db + app healthchecks.
if ! ( cd "$PROJECT_DIR" && docker compose up -d --wait ); then
  echo "knoldr: 'docker compose up' failed. Check Docker, GPU/CUDA, and that host Ollama is running with the configured models." >&2
  exit 1
fi

# Belt-and-suspenders: confirm the MCP host answers /health (verifies the
# in-process workers booted, not just that the container is 'healthy').
i=0
while [ "$i" -lt 60 ]; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/health" 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then
    echo "knoldr: backend healthy at $URL."
    exit 0
  fi
  i=$((i + 1))
  sleep 2
done

echo "knoldr: backend did not become healthy at $URL/health within 120s." >&2
echo "  Tail logs:  (cd $PROJECT_DIR && docker compose logs -f app)" >&2
exit 1
