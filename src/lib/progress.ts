/**
 * Progress reporter threaded through long-running pipeline work
 * (currently `find`'s auto-research, which drives `collect/research`).
 *
 * Transport-neutral on purpose: domain/pipeline code emits progress
 * without depending on the MCP layer. The MCP bridge that turns each
 * emit into a `notifications/progress` lives in src/mcp/progress.ts.
 */
export interface Progress {
  emit(stage: string, data?: Record<string, unknown>): void;
}

/** No-op reporter for callers that don't stream progress. */
export const NOOP_PROGRESS: Progress = { emit: () => {} };
