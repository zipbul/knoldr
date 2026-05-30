// MCP read-only resources — an additive browse surface over the same
// Entry→Claim→KG handlers, for clients that prefer fetch-by-URI to a
// tool round-trip. Each read is a thin URI-parse → existing-handler
// call; no new business logic. The parameterized tools remain the
// primary interface (they express hops/maxDepth/limit/one-of inputs a
// flat resource URI cannot).

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

import { handleContradictions } from './handlers/contradictions';
import { handleNeighbors } from './handlers/neighbors';
import { handleProvenance } from './handlers/provenance';

function one(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

function json(uri: URL, payload: unknown) {
  return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(payload) }] };
}

/** Register the read-only resource views. Listing is disabled (these
 * are parameterized templates resolved on demand, not an enumerable
 * collection), so `list` is undefined. */
export function registerAllResources(server: McpServer): void {
  server.registerResource(
    'claim-provenance',
    new ResourceTemplate('knoldr://claim/{claimId}/provenance', { list: undefined }),
    { title: 'Claim provenance', description: 'derives-from ancestry of a claim (default depth)', mimeType: 'application/json' },
    async (uri, variables) => json(uri, await handleProvenance({ claimId: one(variables.claimId) })),
  );

  server.registerResource(
    'claim-contradictions',
    new ResourceTemplate('knoldr://claim/{claimId}/contradictions', { list: undefined }),
    { title: 'Claim contradictions', description: 'claims that contradict this claim', mimeType: 'application/json' },
    async (uri, variables) => json(uri, await handleContradictions({ claimId: one(variables.claimId) })),
  );

  server.registerResource(
    'entity-neighbors',
    new ResourceTemplate('knoldr://entity/{name}/neighbors', { list: undefined }),
    { title: 'Entity neighbors', description: '1-hop entity-graph neighbors by name', mimeType: 'application/json' },
    async (uri, variables) => json(uri, await handleNeighbors({ entity: one(variables.name) })),
  );
}
