import { configureOnnxRuntime } from './llm/onnx-env';
import { startMcpServer } from './mcp/server';
import { logger } from './observability/logger';
import { startWorkers, stopWorkers } from './workers';

logger.info('knoldr starting');

// Configure onnxruntime thread pool BEFORE any model import so the
// setting takes effect on the first NLI / reranker / QA load.
await configureOnnxRuntime();

// Fail loud here if the DB is misconfigured, rather than inside the
// first worker tick. The container entrypoint already ran migrate.ts
// and compose gates on db health, so this normally returns on attempt 1.
await waitForDb();

// MCP Streamable HTTP transport (per-session) + the 24/7 background
// workers (DB pollers). The workers are NOT tied to any client session.
const httpServer = startMcpServer();
startWorkers();
logger.info('knoldr MCP server + workers started');

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  stopWorkers();
  httpServer.stop(true);
  // Active withClusterLock callbacks release their advisory lock in
  // their own finally{}, so no lock leaks on exit.
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

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
