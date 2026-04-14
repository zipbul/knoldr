import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import type { Message } from "@a2a-js/sdk";
import { v4 as uuid } from "uuid";
import { extractSkillRequest } from "./types";
import { handleFind } from "./handlers/find";
import { handleFeedback } from "./handlers/feedback";
import { logger } from "../observability/logger";

const SUPPORTED_SKILLS = ["find", "feedback"] as const;
type SupportedSkill = (typeof SUPPORTED_SKILLS)[number];

function makeMessage(data: Record<string, unknown>): Message {
  return {
    kind: "message",
    messageId: uuid(),
    role: "agent",
    parts: [{ kind: "data", data }],
  };
}

function runSkill(skill: SupportedSkill, input: Record<string, unknown>): Promise<unknown> {
  switch (skill) {
    case "find":
      return handleFind(input);
    case "feedback":
      return handleFeedback(input) as Promise<unknown>;
  }
}

export class KnoldrExecutor implements AgentExecutor {
  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { userMessage, taskId } = requestContext;

    try {
      const { skill, input } = extractSkillRequest(userMessage.parts);

      if (!SUPPORTED_SKILLS.includes(skill as SupportedSkill)) {
        eventBus.publish(
          makeMessage({ error: `Unknown skill: ${skill}. Supported: ${SUPPORTED_SKILLS.join(", ")}.` }),
        );
        eventBus.finished();
        return;
      }

      logger.info({ skill, taskId }, "executing A2A skill");

      runSkill(skill as SupportedSkill, input)
        .then((result) => {
          eventBus.publish(makeMessage(result as Record<string, unknown>));
          eventBus.finished();
        })
        .catch((err) => {
          eventBus.publish(makeMessage({ error: { code: -32603, message: (err as Error).message } }));
          eventBus.finished();
        });
    } catch (err) {
      const error = err as Error;
      logger.error({ taskId, error: error.message }, "A2A skill execution failed");
      eventBus.publish(
        makeMessage({ error: { code: -32603, message: error.message } }),
      );
      eventBus.finished();
    }
  }

  async cancelTask(_taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    eventBus.finished();
  }
}
