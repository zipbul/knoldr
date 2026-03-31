import type { AgentCard } from "@a2a-js/sdk";

export const agentCard: AgentCard = {
  protocolVersion: "0.3.0",
  name: "knoldr",
  description:
    "AI-native universal data platform. Stores, scores, and retrieves any type of data with near-zero hallucination.",
  url: `http://${process.env.KNOLDR_HOST ?? "0.0.0.0"}:${process.env.KNOLDR_PORT ?? "3000"}`,
  version: "0.2.0",
  capabilities: {
    streaming: false,
    pushNotifications: false,
  },
  defaultInputModes: ["application/json"],
  defaultOutputModes: ["application/json"],
  skills: [
    {
      id: "store",
      name: "Store",
      tags: ["store", "ingest", "data"],
      description:
        "Ingest data via atomic decomposition, dedup, authority scoring. Accepts raw text (Mode 1) or pre-structured entries (Mode 2).",
    },
    {
      id: "query",
      name: "Query",
      tags: ["search", "query", "retrieve"],
      description:
        "Keyword search (pgroonga FTS) with structured filters, freshness decay, and authority ranking. Returns score breakdown + trustLevel.",
    },
    {
      id: "explore",
      name: "Explore",
      tags: ["browse", "explore", "discover"],
      description:
        "Browse entries by domain, tags, authority, trustLevel. Empty query for filter-only browsing.",
    },
    {
      id: "feedback",
      name: "Feedback",
      tags: ["feedback", "quality", "signal"],
      description:
        "Signal positive/negative on entry quality. Rate-limited, audit-logged.",
    },
    {
      id: "audit",
      name: "Audit",
      tags: ["audit", "stats", "monitoring"],
      description:
        "System stats: entry counts, authority distribution, ingestion rates, rejection rates.",
    },
    {
      id: "research",
      name: "Research",
      tags: ["research", "web-search", "async"],
      description:
        "Research a topic via web search, ingest findings. Async task.",
    },
  ],
};
