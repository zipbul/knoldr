#!/bin/sh
# Sync host LLM CLI configs into knoldr-app container.
# Run after `docker compose up -d` or when tokens refresh.
set -e

CONTAINER="knoldr-app-1"

echo "Syncing Codex CLI config..."
for f in auth.json config.toml; do
  src="$HOME/.codex/$f"
  [ -f "$src" ] && docker cp "$src" "$CONTAINER:/root/.codex/$f" && echo "  $f ✓"
done

echo "Syncing Gemini CLI config..."
for f in settings.json oauth_creds.json google_accounts.json installation_id state.json; do
  src="$HOME/.gemini/$f"
  [ -f "$src" ] && docker cp "$src" "$CONTAINER:/root/.gemini/$f" && echo "  $f ✓"
done

echo "Done."
