import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import type { Message } from "@a2a-js/sdk";
import { v4 as uuid } from "uuid";
import { extractSkillRequest } from "./types";
import { handleQuery } from "./handlers/query";
import { handleExplore } from "./handlers/explore";
import { handleResearch } from "./handlers/research";
import { logger } from "../observability/logger";

type SkillHandler = (input: Record<string, unknown>) => Promise<unknown>;

const SYNC_HANDLERS: Record<string, SkillHandler> = {
  query: handleQuery,
  explore: handleExplore,
};

function makeMessage(data: Record<string, unknown>): Message {
  return {
    kind: "message",
    messageId: uuid(),
    role: "agent",
    parts: [{ kind: "data", data }],
  };
}

export class KnoldrExecutor implements AgentExecutor {
  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { userMessage, taskId } = requestContext;

    try {
      const { skill, input } = extractSkillRequest(userMessage.parts);

      // Research: async (don't await, run in background)
      if (skill === "research") {
        logger.info({ skill, taskId }, "starting async research task");

        // Run in background — eventBus.finished() called when done
        handleResearch(input)
          .then((result) => {
            eventBus.publish(makeMessage(result as unknown as Record<string, unknown>));
            eventBus.finished();
          })
          .catch((err) => {
            eventBus.publish(makeMessage({ error: { code: -32603, message: (err as Error).message } }));
            eventBus.finished();
          });

        // Return immediately — SDK keeps task in "working" state until finished()
        return;
      }

      // Sync skills
      const handler = SYNC_HANDLERS[skill];
      if (!handler) {
        eventBus.publish(makeMessage({ error: `Unknown skill: ${skill}` }));
        eventBus.finished();
        return;
      }

      logger.info({ skill, taskId }, "executing A2A skill");

      const result = await handler(input);
      eventBus.publish(makeMessage(result as Record<string, unknown>));
      eventBus.finished();
    } catch (err) {
      const error = err as Error;
      logger.error({ taskId, error: error.message }, "A2A skill execution failed");

      const errorCode = -32603;
      eventBus.publish(
        makeMessage({ error: { code: errorCode, message: error.message } }),
      );
      eventBus.finished();
    }
  }

  async cancelTask(_taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    eventBus.finished();
  }
}
