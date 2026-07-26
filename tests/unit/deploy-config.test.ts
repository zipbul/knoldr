// P0 regression: deployment-config invariants that CI cannot catch by
// running code (the app image is never built/booted in CI).
// The Dockerfile must ship drizzle/ — docker-entrypoint.sh runs
// src/db/migrate.ts which reads ./drizzle; without the COPY the
// container crash-loops on first boot.

import { describe, test, expect } from 'bun:test';

const read = async (p: string) => await Bun.file(`${import.meta.dir}/../../${p}`).text();

describe('deploy config invariants', () => {
  test('Dockerfile copies drizzle/ (migrate reads it at boot)', async () => {
    const dockerfile = await read('Dockerfile');
    expect(dockerfile).toMatch(/^COPY\s+drizzle\/?\s+drizzle\/?$/m);
  });
});
