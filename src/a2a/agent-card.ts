import type { AgentCard } from "@a2a-js/sdk";

export const agentCard: AgentCard = {
  protocolVersion: "0.3.0",
  name: "knoldr",
  description:
    "AI-native universal data platform. Stores, scores, and retrieves any type of data. All skills accept JSON input via parts[0].data = { skill, input }.",
  url: `http://${process.env.KNOLDR_HOST ?? "0.0.0.0"}:${process.env.KNOLDR_PORT ?? "5100"}`,
  version: "0.2.0",
  capabilities: {
    streaming: false,
    pushNotifications: false,
  },
  defaultInputModes: ["application/json"],
  defaultOutputModes: ["application/json"],
  skills: [
    {
      id: "query",
      name: "Query",
      tags: ["search", "query", "retrieve"],
      description: `Keyword search with pgroonga FTS, freshness decay, authority ranking.

Input: { query: string, domain?: string, tags?: string[], language?: string, minAuthority?: number, minTrustLevel?: "high"|"medium"|"low", limit?: number (default 10, max 50), cursor?: string }

Output: { entries: [{ entry: Entry, scores: { relevance, authority, freshness, final }, trustLevel: "high"|"medium"|"low" }], nextCursor?: string }

trustLevel: high (authority >= 0.7), medium (>= 0.4), low (< 0.4).`,
      examples: [
        '{ "skill": "query", "input": { "query": "Bun performance benchmarks" } }',
        '{ "skill": "query", "input": { "query": "xz-utils vulnerability", "domain": "security", "minTrustLevel": "medium", "limit": 5 } }',
      ],
    },
    {
      id: "explore",
      name: "Explore",
      tags: ["browse", "explore", "discover"],
      description: `Browse entries by filters without keyword search.

Input: { domain?: string, tags?: string[], minAuthority?: number, minTrustLevel?: string, sortBy?: "authority"|"created_at", limit?: number, cursor?: string }

Output: same as query.`,
      examples: [
        '{ "skill": "explore", "input": { "domain": "javascript", "sortBy": "authority", "limit": 10 } }',
      ],
    },
    {
      id: "research",
      name: "Research",
      tags: ["research", "web-crawl", "async"],
      description: `Deep Crawl Engine: decompose topic into sub-queries, scrape web for seed URLs, crawl pages (Playwright), extract content, ingest findings. Async — returns immediately, poll with tasks/get.

Input: { topic: string, domain?: string, maxUrls?: number (default 50, max 200), contentTypes?: ["html","pdf","image","youtube"], maxDepth?: number (default 2, max 5), focusDomains?: string[] }

Output: { taskId, entries: [{ entryId, action }], urlsCrawled, status: "completed"|"partial" }`,
      examples: [
        '{ "skill": "research", "input": { "topic": "xz-utils backdoor supply chain attack analysis" } }',
        '{ "skill": "research", "input": { "topic": "Bun vs Node.js benchmarks", "maxUrls": 10, "maxDepth": 1, "contentTypes": ["html"] } }',
      ],
    },
  ],
};
