import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import type { Message } from "@a2a-js/sdk";
import { v4 as uuid } from "uuid";
import { extractSkillRequest } from "./types";
import { handleStore } from "./handlers/store";
import { handleQuery } from "./handlers/query";
import { handleExplore } from "./handlers/explore";
import { handleFeedback } from "./handlers/feedback";
import { handleAudit } from "./handlers/audit";
import { handleResearch } from "./handlers/research";
import { RateLimitError } from "../score/feedback";
import { logger } from "../observability/logger";

type SkillHandler = (input: Record<string, unknown>) => Promise<unknown>;

const SKILL_HANDLERS: Record<string, SkillHandler> = {
  store: handleStore,
  query: handleQuery,
  explore: handleExplore,
  feedback: handleFeedback,
  audit: handleAudit,
  research: handleResearch,
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

      const handler = SKILL_HANDLERS[skill];
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

      const errorCode = err instanceof RateLimitError ? 1003 : -32603;
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
