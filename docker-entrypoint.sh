#!/bin/sh
set -e
bun run src/db/migrate.ts
exec "$@"
