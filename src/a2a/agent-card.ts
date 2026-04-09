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
  cursor?: string,         // pagination
  minResults?: number,     // threshold to trigger auto-research (default 3)
  skipResearch?: boolean,  // skip auto-research (default false)
  maxUrls?: number,        // research: max URLs to crawl (default 10, max 200)
  maxDepth?: number,       // research: crawl depth (default 1, max 5)
  contentTypes?: string[], // research: ["html","pdf","image","youtube"]
  focusDomains?: string[]  // research: prioritize these domains
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
        '{ "skill": "find", "input": { "query": "WebSocket scaling", "minResults": 5, "maxUrls": 20 } }',
      ],
    },
  ],
};
