/** Extract skill id and input from A2A message parts */
export interface SkillRequest {
  skill: string;
  input: Record<string, unknown>;
}

export function extractSkillRequest(parts: Array<{ kind?: string; data?: unknown }>): SkillRequest {
  const dataPart = parts.find((p) => p.kind === "data");
  if (!dataPart?.data || typeof dataPart.data !== "object") {
    throw new Error("Message must contain a data part with skill and input");
  }

  const data = dataPart.data as Record<string, unknown>;
  const skill = data.skill;
  const input = data.input;

  if (typeof skill !== "string") {
    throw new Error("Missing or invalid 'skill' in message data");
  }

  return {
    skill,
    input: (input as Record<string, unknown>) ?? {},
  };
}
