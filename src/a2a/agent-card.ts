import type { AgentCard } from "@a2a-js/sdk";

export const agentCard: AgentCard = {
  protocolVersion: "0.3.0",
  name: "knoldr",
  description:
    "AI-native universal data platform. Searches stored knowledge and auto-collects from the web when results are insufficient. All skills accept JSON input via parts[0].data = { skill, input }.",
  url: `http://${process.env.KNOLDR_HOST ?? "0.0.0.0"}:${process.env.KNOLDR_PORT ?? "5100"}`,
  version: "0.3.0",
  capabilities: {
    streaming: false,
    pushNotifications: false,
  },
  defaultInputModes: ["application/json"],
  defaultOutputModes: ["application/json"],
  skills: [
    {
      id: "find",
      name: "Find",
      tags: ["search", "query", "research", "retrieve", "explore"],
      description: `Search stored knowledge. If results are insufficient, automatically crawls the web to collect new data, then re-searches.

Input: {
  query?: string,          // keyword search (omit for filter-only browsing)
  topic?: string,          // alias for query
  domain?: string,         // filter by domain
  tags?: string[],         // filter by tags
  language?: string,       // ISO 639-1 code
  minAuthority?: number,   // 0-1
  minTrustLevel?: "high"|"medium"|"low",
  limit?: number,          // default 10, max 50
  cursor?: string          // pagination
}

Output: {
  entries: [{ id, title, content, domains, tags, sources, authority, ... }],
  scores: [{ relevance, authority, freshness, final }],
  trustLevels: ["high"|"medium"|"low"],
  nextCursor?: string,
  researched: boolean,
  research?: { urlsCrawled, entriesStored }
}`,
      examples: [
        '{ "skill": "find", "input": { "query": "Bun performance benchmarks" } }',
        '{ "skill": "find", "input": { "query": "xz-utils vulnerability", "domain": "security", "minTrustLevel": "medium" } }',
        '{ "skill": "find", "input": { "domain": "javascript", "limit": 10 } }',
      ],
    },
    {
      id: "feedback",
      name: "Feedback",
      tags: ["feedback", "rating", "authority", "rerank"],
      description: `Record a positive or negative signal against a stored entry. Atomically adjusts the entry's authority score so future \`find\` rankings reflect usage quality.

Input: {
  entryId: string,            // entry.id returned from find
  signal: "positive"|"negative",
  reason?: string,            // freeform, max 1000 chars
  agentId: string             // stable identifier for the caller
}

Rate limits:
  - 1 feedback per (agentId, entryId) per hour
  - 10 feedbacks per entry per hour (any agent)

Output:
  { ok: true,  entryId, newAuthority }
  { ok: false, error: "rate_limited"|"not_found"|"invalid_input", message }`,
      examples: [
        '{ "skill": "feedback", "input": { "entryId": "01HX...", "signal": "positive", "agentId": "agent-42" } }',
        '{ "skill": "feedback", "input": { "entryId": "01HX...", "signal": "negative", "reason": "outdated", "agentId": "agent-42" } }',
      ],
    },
  ],
};
