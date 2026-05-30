import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';

/**
 * Progress reporter threaded through long-running skills (currently
 * only `find`'s auto-research, which also drives `collect/research`).
 *
 * Relocated here from the deleted A2A transport layer so handler
 * modules and collectors can import the type without dragging in the
 * server. The MCP bridge below turns each `emit()` into an MCP
 * `notifications/progress` over the Streamable HTTP SSE channel — but
 * only when the caller opted in with a `_meta.progressToken`.
 */
interface Progress {
  emit(stage: string, data?: Record<string, unknown>): void;
}

/** Used when no client progress token is present — identical to the old non-streaming path. */
const NOOP_PROGRESS: Progress = { emit: () => {} };

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Build a Progress that streams MCP progress notifications for one
 * tool call. No-ops when the client didn't supply a progressToken, so
 * non-streaming callers behave exactly as before. The open Streamable
 * HTTP stream carries the notifications back to the client; we never
 * manage keepalives ourselves (the transport owns the SSE channel).
 */
function makeMcpProgress(extra: ToolExtra): Progress {
  const token = extra._meta?.progressToken;
  if (token === undefined) {
    return NOOP_PROGRESS;
  }
  let counter = 0;
  const send = async (progress: number, message: string): Promise<void> => {
    try {
      await extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress, message },
      });
    } catch {
      // best-effort: a dropped progress frame must never fail the tool call
    }
  };
  return {
    emit(stage, data) {
      // `progress` must strictly increase per token; a local counter
      // guarantees monotonicity regardless of stage order. The stage
      // name plus any processed/total detail rides in `message` (the
      // field clients surface) since structured payloads aren't part
      // of the progress notification schema.
      const message =
        data && typeof data.processed === 'number' && typeof data.total === 'number'
          ? `${stage}: ${data.processed}/${data.total}`
          : stage;
      void send(++counter, message);
    },
  };
}

export { NOOP_PROGRESS, makeMcpProgress };
export type { Progress };
