import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import pkg from '../../package.json' with { type: 'json' };
import { logger } from '../observability/logger';
import { resolveHost, resolvePort } from './net';
import { registerAllTools } from './tools';

// Evict transports for sessions that went idle without an explicit DELETE
// (clients that just disconnect) so the map can't grow unbounded on a 24/7
// server.
const SESSION_IDLE_MS = 10 * 60 * 1000;
const SESSION_SWEEP_MS = 60 * 1000;

const INSTRUCTIONS = `Knoldr — AI-native verified-fact warehouse. Agents are the only data inlet: search the web yourselves and ingest findings WITH cited source URLs; knoldr verifies claims against those cited sources and serves them instantly (find). Rate entries and claims (feedback, claim_feedback); walk the entity and claim graphs (neighbors, provenance, contradictions).`;

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  lastSeen: number;
}

/** A fresh McpServer per session — cheap, since all real state lives in the
 * process-global DB pool and engine modules, not the server. */
function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'knoldr', version: pkg.version }, { instructions: INSTRUCTIONS });
  registerAllTools(server);
  return server;
}

/** Resolve the session's transport (refreshing its lastSeen), or open a new
 * one for an initialize POST. Returns a 400 Response when a non-POST arrives
 * without a live session. */
async function getOrCreateTransport(
  req: Request,
  sessions: Map<string, Session>,
): Promise<WebStandardStreamableHTTPServerTransport | Response> {
  const sessionId = req.headers.get('mcp-session-id') ?? undefined;
  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (existing) {
      existing.lastSeen = Date.now();
      return existing.transport;
    }
  }
  if (req.method !== 'POST') {
    return new Response('Bad Request: no valid session', { status: 400 });
  }
  const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: id => {
      sessions.set(id, { transport, lastSeen: Date.now() });
    },
    onsessionclosed: id => {
      sessions.delete(id);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) {
      sessions.delete(transport.sessionId);
    }
  };
  await buildMcpServer().connect(transport);
  return transport;
}

async function handleMcp(req: Request, sessions: Map<string, Session>): Promise<Response> {
  const transport = await getOrCreateTransport(req, sessions);
  if (transport instanceof Response) {
    return transport;
  }
  return transport.handleRequest(req);
}

/**
 * Start the Knoldr MCP server: a single Bun.serve listener exposing the MCP
 * Streamable HTTP endpoint at POST/GET /mcp plus the unauthenticated /health
 * and /metrics routes. Streamable HTTP sessions are decoupled from this
 * process lifetime — the 24/7 background workers run independently (see
 * src/workers).
 */
function startMcpServer() {
  const port = resolvePort();
  const host = resolveHost();

  const sessions = new Map<string, Session>();
  setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, session] of sessions) {
      if (session.lastSeen < cutoff) {
        sessions.delete(id);
        void session.transport.close();
      }
    }
  }, SESSION_SWEEP_MS);

  const server = Bun.serve({
    port,
    hostname: host,
    // Long non-streaming tool calls (ingest runs LLM decompose, Ollama
    // timeout 120s) must not be severed mid-flight; the transport streams
    // progress notifications over this connection, but keep a generous idle
    // window as a backstop.
    idleTimeout: 255,
    async fetch(req) {
      const path = new URL(req.url).pathname;

      if (req.method === 'GET' && path === '/health') {
        const { getHealthStatus } = await import('../observability/health');
        return Response.json(await getHealthStatus());
      }
      if (req.method === 'GET' && path === '/metrics') {
        const { getMetrics } = await import('../observability/metrics');
        return new Response(await getMetrics(), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
      if (path === '/mcp') {
        return handleMcp(req, sessions);
      }
      return new Response('Not Found', { status: 404 });
    },
  });

  logger.info({ port, host }, 'knoldr MCP server started');
  return server;
}

export { startMcpServer };
