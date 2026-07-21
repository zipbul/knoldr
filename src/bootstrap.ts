import { configureOnnxRuntime } from './llm/onnx-env';
import { startMcpServer } from './mcp/server';
import { logger } from './observability/logger';
import { startWorkers, stopWorkers } from './workers';

async function waitForDb(): Promise<void> {
  const { getDb } = await import('./db/connection');
  const { sql } = await import('drizzle-orm');
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await getDb().execute(sql`SELECT 1`);
      return;
    } catch (err) {
      logger.warn({ attempt, error: (err as Error).message }, 'waiting for database');
      await Bun.sleep(1000);
    }
  }
  throw new Error('database not reachable after 10 attempts');
}

function installShutdown(httpServer: ReturnType<typeof startMcpServer>): void {
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    stopWorkers();
    void httpServer.stop(true);
    // Active withClusterLock callbacks release their advisory lock in their
    // own finally{}, so no lock leaks on exit.
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/**
 * Full application bootstrap, shared by the container entrypoint
 * (src/index.ts) and the `knoldr serve` CLI command so both get ONNX setup,
 * DB-readiness, and signal-driven graceful shutdown identically. The MCP
 * server (per-session transports) and the 24/7 background workers run
 * independently of each other.
 */
export async function startApp(): Promise<void> {
  logger.info('knoldr starting');
  // ONNX thread pool must be configured BEFORE any model import.
  await configureOnnxRuntime();
  // Fail loud here if the DB is misconfigured, rather than inside the first
  // worker tick. The container entrypoint already ran migrate.ts.
  await waitForDb();
  const httpServer = startMcpServer();
  startWorkers();
  installShutdown(httpServer);
  logger.info('knoldr MCP server + workers started');
}
