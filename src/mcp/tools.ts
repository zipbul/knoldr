// MCP tool registration. Each of Knoldr's 7 skills becomes one MCP
// tool, 1:1 with the existing transport-agnostic handler. The handler
// owns its own zod schema (including any .refine cross-field rules,
// which run in-handler and are restated in the descriptions below
// because they don't survive the zod -> JSON-Schema projection MCP
// publishes). Input shapes are imported from the handlers so the
// advertised schema and the in-handler validation share one source.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { logger } from '../observability/logger';
import { ANONYMOUS_AGENT } from './auth';
import { handleClaimFeedback, claimFeedbackInputShape } from './handlers/claim-feedback';
import { handleContradictions, contradictionsInputShape } from './handlers/contradictions';
import { handleFeedback, feedbackInputShape } from './handlers/feedback';
import { handleFind, findInputShape } from './handlers/find';
import { handleIngest, ingestInputShape } from './handlers/ingest';
import { handleNeighbors, neighborsInputShape } from './handlers/neighbors';
import { handleProvenance, provenanceInputShape } from './handlers/provenance';
import { makeMcpProgress } from './progress';

/**
 * Wrap a handler result as an MCP tool result. Domain outcomes
 * (`{ ok: false, error }`) travel as normal structured content — they
 * are successful tool calls reporting a domain result, not protocol
 * errors. Only an unexpected throw becomes `isError`, and its detail
 * is logged, never echoed (no SQL/stack leakage to the caller).
 */
function ok(result: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result as { [key: string]: unknown },
  };
}

async function guard(tool: string, run: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await run());
  } catch (err) {
    logger.error({ tool, error: (err as Error).message }, 'mcp tool failed');
    return { content: [{ type: 'text', text: 'Internal error' }], isError: true };
  }
}

/** The caller's server-derived agent id, carried as MCP authInfo by the
 * /mcp boundary (resolved from the bearer token). Used to attribute
 * feedback/claim_feedback to the real caller, never a self-asserted id. */
function callerAgent(extra: { authInfo?: { clientId?: string } }): string {
  return extra.authInfo?.clientId ?? ANONYMOUS_AGENT;
}

const FIND_DESC = `Search the verified-fact warehouse. Instant, stored-data only — knoldr NEVER searches the web.

Input: { query?, topic? (alias for query; omit both for filter-only browsing), domain?, tags?, language? (ISO 639-1), minAuthority? (0-1), minTrustLevel? "high"|"medium"|"low", limit? (default 10, max 50), cursor? }
Output: { entries[], scores[], trustLevels[], nextCursor?, factBundles[] (verified atomic claims + 1-hop graph context: supports/contradicts/derivesFrom/supersededBy/refines) }
Thin results mean the warehouse does not know this topic yet: run your own web search for immediate needs, ingest what you find WITH cited source URLs (they will be verified), then re-query later for verified factBundles`;

const INGEST_DESC = `Submit pre-extracted text into Knoldr. The agent owns format conversion (PDF/OCR/ASR/local-file); hand plain text here. Provide exactly one of 'raw' or 'entries'.

Mode 1 — raw: { raw: string (<=200000 chars), sources?: [{ url, sourceType, trust? }] }  (LLM decomposes into atomic entries)
Mode 2 — structured: { entries: [{ title, content, domain: string[], tags?, language? }], sources? }  (skips decompose)
sourceType ∈ official-docs|github-release|cve-db|official-blog|research-paper|established-blog|community-forum|personal-blog|ai-generated|reference-wiki|unknown
Output: { ok: true, results[], storedCount, duplicateCount, rejectedCount } | { ok: false, error, message }
You are the data inlet — ALWAYS cite source URLs: verification grounds each claim against its cited live sources, and uncited factual claims stay unverified forever. Stored entries flow through claim extraction + verification automatically.`;

const FEEDBACK_DESC = `Record a positive/negative signal against a stored entry; atomically adjusts the entry's authority used by future find rankings. Your agent identity comes from your authenticated token — do NOT pass an agent id.

Input: { entryId, signal: "positive"|"negative", reason?, note? (<=1000) }
Rate limits: 1 per (caller, entryId) per hour; 10 per entry per hour.
Output: { ok: true, entryId, newAuthority } | { ok: false, error: "rate_limited"|"not_found"|"invalid_input", message }`;

const CLAIM_FEEDBACK_DESC = `Record claim-level structured feedback against a specific atomic claim (distinct from entry-level feedback). Captures HOW the claim was applied, the OUTCOME, and WHICH dimension failed. Your reporter identity comes from your authenticated token — do NOT pass a reporter id.

Input: { claimId, applicationMethod: "verified"|"applied"|"cited"|"reasoned-over", outcome: "held"|"failed"|"partial", failureDimension? (for failed/partial; MUST be omitted when outcome="held"), partialTruth? (0-1), contextDomain?, contextTimeFrom?, contextTimeUntil? (ISO), contextScope?, counterSourceUrl?, counterClaimText?, counterNliScore? (0-1), auditNote? (<=4000) }
Update mode: pass an existing feedbackId (same caller + claimId) to fill NULL fields on the same row.
Output: { ok: true, feedbackId, claimId, evidenceStrength, reporterFeedbackAuthority, enrichmentStatus, updated } | { ok: false, error, message, missingRequired? }`;

const NEIGHBORS_DESC = `Walk the entity knowledge graph from a root entity. entity may be a ULID or a case-insensitive name (pass entityType to disambiguate when a name spans multiple types).

Input: { entity, entityType?, relationType?, hops? (1-4, default 1), limit? (default 50, max 200) }
Output: { ok: true, root, neighbors: [{ id, name, type, distance, viaRelations[] }] } | { ok: false, error: "invalid_input"|"entity_not_found"|"ambiguous_entity", message, candidates? }`;

const PROVENANCE_DESC = `Walk the derives-from chain from a claim back to its supporting ancestors.

Input: { claimId, maxDepth? (1-8, default 4) }
Output: { ok: true, rootClaimId, ancestors: [{ claimId, statement, verdict, certainty, sourceUrl, depth }] } | { ok: false, error: "invalid_input"|"claim_not_found", message }`;

const CONTRADICTIONS_DESC = `Surface CONTRADICTS edges for a claim or an entity-shaped area of the graph. Returns claim PAIRS so both sides of a dispute are visible. Provide exactly one of claimId or entity.

Input: { claimId?, entity?, limit? (default 20, max 50) }
Output: { ok: true, pairs: [{ fromClaimId, fromStatement, fromVerdict, fromCertainty, toClaimId, toStatement, toVerdict, toCertainty, weight }] } | { ok: false, error: "invalid_input", message }`;

/** Register all 7 Knoldr skills as MCP tools on the given server. */
export function registerAllTools(server: McpServer): void {
  server.registerTool(
    'find',
    {
      title: 'Find',
      description: FIND_DESC,
      inputSchema: findInputShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args, extra) => guard('find', () => handleFind(args as Record<string, unknown>, makeMcpProgress(extra))),
  );

  server.registerTool(
    'ingest',
    {
      title: 'Ingest',
      description: INGEST_DESC,
      inputSchema: ingestInputShape,
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    args => guard('ingest', () => handleIngest(args as Record<string, unknown>)),
  );

  server.registerTool(
    'feedback',
    { title: 'Feedback', description: FEEDBACK_DESC, inputSchema: feedbackInputShape, annotations: { readOnlyHint: false } },
    (args, extra) => guard('feedback', () => handleFeedback(args as Record<string, unknown>, callerAgent(extra))),
  );

  server.registerTool(
    'claim_feedback',
    {
      title: 'Claim Feedback',
      description: CLAIM_FEEDBACK_DESC,
      inputSchema: claimFeedbackInputShape,
      annotations: { readOnlyHint: false },
    },
    (args, extra) => guard('claim_feedback', () => handleClaimFeedback(args as Record<string, unknown>, callerAgent(extra))),
  );

  server.registerTool(
    'neighbors',
    {
      title: 'Entity Neighbors',
      description: NEIGHBORS_DESC,
      inputSchema: neighborsInputShape,
      annotations: { readOnlyHint: true },
    },
    args => guard('neighbors', () => handleNeighbors(args as Record<string, unknown>)),
  );

  server.registerTool(
    'provenance',
    {
      title: 'Claim Provenance',
      description: PROVENANCE_DESC,
      inputSchema: provenanceInputShape,
      annotations: { readOnlyHint: true },
    },
    args => guard('provenance', () => handleProvenance(args as Record<string, unknown>)),
  );

  server.registerTool(
    'contradictions',
    {
      title: 'Surface Contradictions',
      description: CONTRADICTIONS_DESC,
      inputSchema: contradictionsInputShape,
      annotations: { readOnlyHint: true },
    },
    args => guard('contradictions', () => handleContradictions(args as Record<string, unknown>)),
  );
}
