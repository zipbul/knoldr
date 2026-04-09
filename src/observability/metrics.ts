import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from "prom-client";

const register = new Registry();
collectDefaultMetrics({ register });

// Ingestion metrics
export const ingestionTotal = new Counter({
  name: "knoldr_ingestion_total",
  help: "Total ingestion operations",
  labelNames: ["action"] as const,
  registers: [register],
});

export const ingestionLatency = new Histogram({
  name: "knoldr_ingestion_latency_ms",
  help: "Ingestion latency in milliseconds",
  registers: [register],
});

// Search metrics
export const searchTotal = new Counter({
  name: "knoldr_search_total",
  help: "Total search operations",
  registers: [register],
});

export const searchLatency = new Histogram({
  name: "knoldr_search_latency_ms",
  help: "Search latency in milliseconds",
  registers: [register],
});

// Feedback metrics
export const feedbackTotal = new Counter({
  name: "knoldr_feedback_total",
  help: "Total feedback operations",
  labelNames: ["signal"] as const,
  registers: [register],
});

// Entry count gauge
export const entryCount = new Gauge({
  name: "knoldr_entry_count",
  help: "Current entry count",
  labelNames: ["status"] as const,
  registers: [register],
});

// API health gauge
export const apiHealth = new Gauge({
  name: "knoldr_api_health",
  help: "External API health status (1=up, 0=down)",
  labelNames: ["provider", "status"] as const,
  registers: [register],
});

// Research metrics
export const researchTotal = new Counter({
  name: "knoldr_research_total",
  help: "Total research operations",
  labelNames: ["status"] as const,
  registers: [register],
});

export async function getMetrics(): Promise<string> {
  return register.metrics();
}
