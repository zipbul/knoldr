import { timingSafeEqual } from 'node:crypto';

import { isLoopbackHost, resolveHost } from './net';

const ANONYMOUS_AGENT = 'anonymous';

/**
 * Parse the optional per-agent token registry:
 *   KNOLDR_AGENT_TOKENS="alice:tok_alice,bob:tok_bob"
 * Each token maps to a distinct, server-known agent id so the caller's
 * identity can be derived from the credential rather than self-asserted.
 */
function parseAgentTokens(): Map<string, string> {
  const raw = process.env.KNOLDR_AGENT_TOKENS;
  const map = new Map<string, string>();
  if (!raw) {
    return map;
  }
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf(':');
    if (idx <= 0) {
      continue;
    }
    const agentId = pair.slice(0, idx).trim();
    const token = pair.slice(idx + 1).trim();
    if (agentId && token) {
      map.set(agentId, token);
    }
  }
  return map;
}

function extractBearer(request: Request): string | null {
  const authHeader = request.headers.get('authorization');
  if (!authHeader) {
    return null;
  }
  const [scheme, value] = authHeader.split(' ');
  if (!scheme || !value || scheme.toLowerCase() !== 'bearer') {
    return null;
  }
  return value;
}

/**
 * Resolve the caller's principal (agent id) from the Bearer token, or
 * null if unauthorized. Identity is SERVER-DERIVED from the token — a
 * caller's self-asserted agent id is never trusted for authority weighting.
 *
 *  - KNOLDR_AGENT_TOKENS ("a:tokA,b:tokB") → that agent's id
 *  - KNOLDR_API_TOKEN (single shared) → KNOLDR_DEFAULT_AGENT_ID (default "default")
 *  - no tokens configured + non-production → "anonymous" (loopback dev only;
 *    requireTokenOrThrow already refused a non-loopback bind without a token)
 *
 * Comparison uses node:crypto `timingSafeEqual` over fixed-size buffers so
 * an attacker cannot learn token bytes from response-time variance.
 */
function authenticate(request: Request): string | null {
  const agentTokens = parseAgentTokens();
  const shared = process.env.KNOLDR_API_TOKEN;

  if (agentTokens.size === 0 && !shared) {
    return process.env.NODE_ENV === 'production' ? null : ANONYMOUS_AGENT;
  }

  const presented = extractBearer(request);
  if (!presented) {
    return null;
  }
  for (const [agentId, token] of agentTokens) {
    if (constantTimeEqual(presented, token)) {
      return agentId;
    }
  }
  if (shared && constantTimeEqual(presented, shared)) {
    return process.env.KNOLDR_DEFAULT_AGENT_ID ?? 'default';
  }
  return null;
}

/**
 * Call from server startup. Refuses to start when the listener would be
 * both reachable and unauthenticated:
 *  - production without a token (existing fail-closed policy), or
 *  - any environment binding a NON-loopback host without a token.
 * The genuine danger is "reachable + unauthenticated", so that
 * combination fails closed regardless of NODE_ENV. A loopback-only dev
 * server with no token is still allowed (and warns at startup).
 */
function requireTokenOrThrow(): void {
  const hasToken = !!process.env.KNOLDR_API_TOKEN || !!process.env.KNOLDR_AGENT_TOKENS;
  if (hasToken) {
    return;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('KNOLDR_API_TOKEN is required in production (fail-closed auth policy)');
  }
  const host = resolveHost();
  if (!isLoopbackHost(host)) {
    throw new Error(`KNOLDR_API_TOKEN is required when binding a non-loopback host (KNOLDR_HOST=${host})`);
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  // Pad both sides to the longer length so timingSafeEqual (which requires
  // equal lengths) still runs in constant time. The length comparison at
  // the end keeps mismatched-length inputs as "not equal" without leaking
  // byte-level info about the real token.
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  const len = Math.max(aBuf.length, bBuf.length);
  const aPad = Buffer.alloc(len);
  const bPad = Buffer.alloc(len);
  aBuf.copy(aPad);
  bBuf.copy(bPad);
  const eq = timingSafeEqual(aPad, bPad);
  return eq && aBuf.length === bBuf.length;
}

export { authenticate, requireTokenOrThrow, ANONYMOUS_AGENT };
