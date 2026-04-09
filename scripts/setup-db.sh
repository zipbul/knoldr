#!/bin/bash
set -e

# Knoldr DB setup script
# Prerequisites: PostgreSQL installed with superuser access

DB_NAME="${1:-knoldr}"
DB_USER="${2:-$(whoami)}"

echo "=== Knoldr DB Setup ==="
echo "Database: $DB_NAME"
echo "User: $DB_USER"
echo ""

# Install PostgreSQL extensions (requires superuser)
echo "1. Installing extensions..."

# Check if pgroonga is available
if ! psql -c "SELECT * FROM pg_available_extensions WHERE name = 'pgroonga'" | grep -q pgroonga; then
  echo "   pgroonga extension not found. Install it first:"
  echo "   Ubuntu/Debian: sudo apt install postgresql-17-pgdg-pgroonga"
  echo "   macOS: brew install pgroonga"
  echo "   See: https://pgroonga.github.io/install/"
  exit 1
fi

# Check if pgvector is available
if ! psql -c "SELECT * FROM pg_available_extensions WHERE name = 'vector'" | grep -q vector; then
  echo "   pgvector extension not found. Install it first:"
  echo "   Ubuntu/Debian: sudo apt install postgresql-17-pgvector"
  echo "   macOS: brew install pgvector"
  echo "   See: https://github.com/pgvector/pgvector"
  exit 1
fi

echo "   Extensions available."

# Create database
echo "2. Creating database..."
psql -c "CREATE DATABASE $DB_NAME" 2>/dev/null || echo "   Database '$DB_NAME' already exists."

# Create extensions
echo "3. Enabling extensions..."
psql -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS vector"
psql -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS pgroonga"

echo "4. Running migrations..."
DATABASE_URL="postgres://$DB_USER@localhost:5432/$DB_NAME" bun run db:migrate

echo ""
echo "=== Done ==="
echo "Add to .env:"
echo "  DATABASE_URL=postgres://$DB_USER@localhost:5432/$DB_NAME"
