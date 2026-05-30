import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import pkg from '../../package.json' with { type: 'json' };
import { logger } from '../observability/logger';
import { authenticate, requireTokenOrThrow } from './auth';
import { registerAllResources } from './resources';
import { registerAllTools } from './tools';

// Hard cap on request body size. MCP tool calls carry small `input`
// objects; any legitimate request is <1MB. We count actual consumed
// bytes (not the Content-Length header a client could lie about).
const MAX_BODY_BYTES = 1 * 1024 * 1024;

const INSTRUCTIONS = `Knoldr — AI-native verified-fact warehouse. Search stored knowledge and auto-collect from the web (find); submit text (ingest); rate entries and claims (feedback, claim_feedback); and walk the entity and claim graphs (neighbors, provenance, contradictions).`;

/** A fresh McpServer per session — cheap, since all real state lives
 * in the process-global DB pool and engine modules, not the server. */
function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'knoldr', version: pkg.version }, { instructions: INSTRUCTIONS });
  registerAllTools(server);
  registerAllResources(server);
  return server;
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '::ffff:127.0.0.1';
}

/** DNS-rebinding guard: a browser would send an Origin header. Non-browser
 * MCP clients (Claude Code) send none, which we allow. A present Origin
 * must resolve to a loopback / configured host. */
function originAllowed(origin: string | null, host: string): boolean {
  if (!origin) {
    return true;
  }
  try {
    const h = new URL(origin).hostname;
    return isLoopback(h) || h === host;
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

/**
 * Start the Knoldr MCP server: a single Bun.serve listener exposing the
 * MCP Streamable HTTP endpoint at POST/GET /mcp plus the unauthenticated
 * /health and /metrics routes. Streamable HTTP sessions are decoupled
 * from this process lifetime — the 24/7 background workers run
 * independently (see src/workers).
 */
function startMcpServer() {
  requireTokenOrThrow();
  const port = Number(process.env.KNOLDR_PORT ?? 5100);
  const host = process.env.KNOLDR_HOST ?? '127.0.0.1';

  if (!process.env.KNOLDR_API_TOKEN && process.env.NODE_ENV !== 'production') {
    logger.warn('KNOLDR_API_TOKEN unset — /mcp is UNAUTHENTICATED (dev mode); bind loopback only');
  }

  // One transport per Streamable HTTP session, keyed by mcp-session-id.
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

  const server = Bun.serve({
    port,
    hostname: host,
    // `find` auto-research can run for minutes; the transport streams
    // progress notifications over this connection, but keep a generous
    // idle window as a backstop.
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (req.method === 'GET' && path === '/health') {
        const { getHealthStatus } = await import('../observability/health');
        return Response.json(await getHealthStatus());
      }

      if (req.method === 'GET' && path === '/metrics') {
        const { getMetrics } = await import('../observability/metrics');
        return new Response(await getMetrics(), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }

      if (path === '/mcp') {
        return handleMcp(req, host, transports);
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  logger.info({ port, host }, 'knoldr MCP server started');
  return server;
}

async function handleMcp(
  req: Request,
  host: string,
  transports: Map<string, WebStandardStreamableHTTPServerTransport>,
): Promise<Response> {
  if (!originAllowed(req.headers.get('origin'), host)) {
    return new Response('Forbidden', { status: 403 });
  }
  if (!authenticate(req)) {
    return unauthorized();
  }

  // Enforce the body cap by counting actual bytes, then hand the
  // pre-parsed body to the transport so it doesn't re-read the stream.
  let options: { parsedBody?: unknown } | undefined;
  if (req.method === 'POST') {
    const declared = Number(req.headers.get('content-length') ?? -1);
    if (declared > MAX_BODY_BYTES) {
      return new Response('Payload too large', { status: 413 });
    }
    const buf = await req.arrayBuffer();
    if (buf.byteLength > MAX_BODY_BYTES) {
      return new Response('Payload too large', { status: 413 });
    }
    try {
      options = { parsedBody: JSON.parse(new TextDecoder().decode(buf)) };
    } catch {
      return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  const sessionId = req.headers.get('mcp-session-id') ?? undefined;
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport) {
    // No live session: only a POST (an initialize request) may open one.
    if (req.method !== 'POST') {
      return new Response('Bad Request: no valid session', { status: 400 });
    }
    transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: id => {
        transports.set(id, transport!);
      },
      onsessionclosed: id => {
        transports.delete(id);
      },
    });
    transport.onclose = () => {
      if (transport!.sessionId) {
        transports.delete(transport!.sessionId);
      }
    };
    const mcp = buildMcpServer();
    await mcp.connect(transport);
  }

  return transport.handleRequest(req, options);
}

export { startMcpServer };
