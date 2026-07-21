import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import pkg from '../../package.json' with { type: 'json' };
import { logger } from '../observability/logger';
import { authenticate, requireTokenOrThrow } from './auth';
import { isLoopbackHost, resolveHost, resolvePort } from './net';
import { registerAllTools } from './tools';

// Hard cap on request body size. MCP tool calls carry small `input`
// objects; any legitimate request is <1MB. We count actual consumed
// bytes (not the Content-Length header a client could lie about).
const MAX_BODY_BYTES = 1 * 1024 * 1024;

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

// ---- request admission ----

/** DNS-rebinding guard: a browser would send an Origin header. Non-browser
 * MCP clients (Claude Code) send none, which we allow. A present Origin
 * must resolve to a loopback / configured host. */
function originAllowed(origin: string | null, host: string): boolean {
  if (!origin) {
    return true;
  }
  try {
    const h = new URL(origin).hostname;
    return isLoopbackHost(h) || h === host;
  } catch {
    return false;
  }
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="knoldr"' },
  });
}

/** Read, size-cap, and JSON-parse a POST body. Returns the parsed body, an
 * error Response the caller should return as-is (413 / parse error), or null
 * for a non-POST request (no body). Counting actual bytes defeats a lying
 * Content-Length; the pre-parsed body is handed to the transport so it
 * doesn't re-read the stream. */
async function readCappedJsonBody(req: Request): Promise<{ body: unknown } | { error: Response } | null> {
  if (req.method !== 'POST') {
    return null;
  }
  const declared = Number(req.headers.get('content-length') ?? -1);
  if (declared > MAX_BODY_BYTES) {
    return { error: new Response('Payload too large', { status: 413 }) };
  }
  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) {
    return { error: new Response('Payload too large', { status: 413 }) };
  }
  try {
    return { body: JSON.parse(new TextDecoder().decode(buf)) };
  } catch {
    return {
      error: new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    };
  }
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

async function handleMcp(req: Request, host: string, sessions: Map<string, Session>): Promise<Response> {
  if (!originAllowed(req.headers.get('origin'), host)) {
    return new Response('Forbidden', { status: 403 });
  }
  const agentId = authenticate(req);
  if (agentId === null) {
    return unauthorized();
  }
  // Identity is server-derived from the bearer token; carry it as MCP
  // authInfo so feedback / claim_feedback attribute to the real caller.
  const authInfo = { token: 'mcp-bearer', clientId: agentId, scopes: [] as string[] };

  const parsed = await readCappedJsonBody(req);
  if (parsed && 'error' in parsed) {
    return parsed.error;
  }

  const transport = await getOrCreateTransport(req, sessions);
  if (transport instanceof Response) {
    return transport;
  }

  return transport.handleRequest(req, parsed ? { authInfo, parsedBody: parsed.body } : { authInfo });
}

/**
 * Start the Knoldr MCP server: a single Bun.serve listener exposing the MCP
 * Streamable HTTP endpoint at POST/GET /mcp plus the unauthenticated /health
 * and /metrics routes. Streamable HTTP sessions are decoupled from this
 * process lifetime — the 24/7 background workers run independently (see
 * src/workers).
 */
function startMcpServer() {
  requireTokenOrThrow();
  const port = resolvePort();
  const host = resolveHost();

  if (!process.env.KNOLDR_API_TOKEN && process.env.NODE_ENV !== 'production') {
    logger.warn('KNOLDR_API_TOKEN unset — /mcp is UNAUTHENTICATED (dev mode); bind loopback only');
  }

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
        return handleMcp(req, host, sessions);
      }
      return new Response('Not Found', { status: 404 });
    },
  });

  logger.info({ port, host }, 'knoldr MCP server started');
  return server;
}

export { startMcpServer };
