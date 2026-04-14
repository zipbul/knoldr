import {
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  InMemoryTaskStore,
  DefaultExecutionEventBusManager,
} from "@a2a-js/sdk/server";
import { agentCard } from "./agent-card";
import { KnoldrExecutor } from "./dispatcher";
import { authenticate } from "./auth";
import { logger } from "../observability/logger";

let transportHandler: JsonRpcTransportHandler;

function getTransportHandler(): JsonRpcTransportHandler {
  if (!transportHandler) {
    const executor = new KnoldrExecutor();
    const taskStore = new InMemoryTaskStore();
    const eventBusManager = new DefaultExecutionEventBusManager();

    const requestHandler = new DefaultRequestHandler(
      agentCard,
      taskStore,
      executor,
      eventBusManager,
    );

    transportHandler = new JsonRpcTransportHandler(requestHandler);
  }
  return transportHandler;
}

export function startServer() {
  const port = Number(process.env.KNOLDR_PORT ?? 5100);
  const host = process.env.KNOLDR_HOST ?? "0.0.0.0";

  const server = Bun.serve({
    port,
    hostname: host,
    // `find` auto-research can run for minutes (LangSearch + LLM decompose +
    // embed). Bun's default idleTimeout (10s) closes the SSE stream before
    // the final event arrives, so raise it to cover the research budget.
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // Agent Card — no auth required
      if (req.method === "GET" && path === "/.well-known/agent-card.json") {
        return Response.json(agentCard);
      }

      // Health check — no auth required
      if (req.method === "GET" && path === "/health") {
        const { getHealthStatus } = await import("../observability/health");
        return Response.json(await getHealthStatus());
      }

      // Metrics — no auth required
      if (req.method === "GET" && path === "/metrics") {
        const { getMetrics } = await import("../observability/metrics");
        const metrics = await getMetrics();
        return new Response(metrics, {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      // A2A JSON-RPC endpoint — auth required
      if (req.method === "POST" && path === "/a2a") {
        if (!authenticate(req)) {
          return Response.json(
            { jsonrpc: "2.0", error: { code: 1004, message: "Unauthorized" }, id: null },
            { status: 401 },
          );
        }

        try {
          const body = await req.json();
          const handler = getTransportHandler();
          const result = await handler.handle(body);

          // handle() returns JSONRPCResponse for `message/send` or an
          // AsyncGenerator for `message/stream`/`tasks/resubscribe`.
          if (isAsyncGenerator(result)) {
            return streamSse(result);
          }

          return Response.json(result);
        } catch (err) {
          logger.error({ error: (err as Error).message }, "A2A request failed");
          return Response.json(
            {
              jsonrpc: "2.0",
              error: { code: -32603, message: (err as Error).message },
              id: null,
            },
            { status: 500 },
          );
        }
      }


      return new Response("Not Found", { status: 404 });
    },
  });

  // Batch dedup job — daily at UTC 03:00
  // Track last run date to avoid missing if not polled exactly at hour 3
  let lastDedupDate = "";
  setInterval(async () => {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    if (now.getUTCHours() >= 3 && lastDedupDate !== todayStr) {
      lastDedupDate = todayStr;
      try {
        const { batchDedup } = await import("../collect/batch-dedup");
        await batchDedup();
      } catch (err) {
        logger.error({ error: (err as Error).message }, "batch dedup failed");
      }
    }
  }, 10 * 60 * 1000); // check every 10 minutes

  // Retry queue processor — every 5 minutes
  setInterval(async () => {
    try {
      const { processRetryQueue } = await import("../collect/retry");
      await processRetryQueue();
    } catch (err) {
      logger.error({ error: (err as Error).message }, "retry queue processing failed");
    }
  }, 5 * 60 * 1000);

  logger.info({ port, host }, "knoldr A2A server started");
  return server;
}

function isAsyncGenerator(obj: unknown): obj is AsyncGenerator {
  return obj !== null && typeof obj === "object" && Symbol.asyncIterator in (obj as object);
}

/** Forward an A2A SDK AsyncGenerator as a text/event-stream response.
 * Emits an SSE comment line every KEEPALIVE_MS so the TCP connection
 * does not hit Bun's idleTimeout between executor events. */
function streamSse(gen: AsyncGenerator<unknown>): Response {
  const encoder = new TextEncoder();
  const KEEPALIVE_MS = 15_000;

  const stream = new ReadableStream({
    async start(controller) {
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keepalive\n\n`));
        } catch {
          // controller may already be closed
        }
      }, KEEPALIVE_MS);

      try {
        for await (const event of gen) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
      } catch (err) {
        const payload = {
          jsonrpc: "2.0",
          error: { code: -32603, message: (err as Error).message },
          id: null,
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        logger.error({ error: (err as Error).message }, "A2A stream failed");
      } finally {
        clearInterval(keepalive);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
