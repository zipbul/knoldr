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
  const port = Number(process.env.KNOLDR_PORT ?? 3000);
  const host = process.env.KNOLDR_HOST ?? "0.0.0.0";

  const server = Bun.serve({
    port,
    hostname: host,
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

          // handle() returns JSONRPCResponse or AsyncGenerator
          if (isAsyncGenerator(result)) {
            // Streaming not supported in v0.2, collect first result
            const first = await result.next();
            return Response.json(first.value);
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

      // Webhook endpoint
      if (req.method === "POST" && path.startsWith("/webhook/")) {
        const feedId = path.split("/webhook/")[1];
        if (!feedId) return Response.json({ error: "Missing feed ID" }, { status: 400 });

        const authToken = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
        const body = (await req.json()) as { content: string; url?: string; sourceType?: string };

        const { handleWebhook } = await import("../collect/feeds/webhook");
        const result = await handleWebhook(feedId, body, authToken);

        if (!result.ok) {
          const status = result.error === "Unauthorized" ? 401 : result.error === "Feed not found" ? 404 : 400;
          return Response.json(result, { status });
        }
        return Response.json(result);
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  logger.info({ port, host }, "knoldr A2A server started");
  return server;
}

function isAsyncGenerator(obj: unknown): obj is AsyncGenerator {
  return obj !== null && typeof obj === "object" && Symbol.asyncIterator in (obj as object);
}
