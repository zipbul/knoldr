import { Registry, Counter, Histogram, collectDefaultMetrics } from "prom-client";

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

export async function getMetrics(): Promise<string> {
  return register.metrics();
}
