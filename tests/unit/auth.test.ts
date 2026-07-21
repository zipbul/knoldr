import { describe, test, expect, afterEach } from 'bun:test';

import { authenticate } from '../../src/mcp/auth';

describe('authenticate', () => {
  const originalToken = process.env.KNOLDR_API_TOKEN;
  const originalAgentTokens = process.env.KNOLDR_AGENT_TOKENS;

  afterEach(() => {
    if (originalToken) {
      process.env.KNOLDR_API_TOKEN = originalToken;
    } else {
      delete process.env.KNOLDR_API_TOKEN;
    }
    if (originalAgentTokens) {
      process.env.KNOLDR_AGENT_TOKENS = originalAgentTokens;
    } else {
      delete process.env.KNOLDR_AGENT_TOKENS;
    }
  });

  test('no token configured (dev) resolves the anonymous principal', () => {
    delete process.env.KNOLDR_API_TOKEN;
    delete process.env.KNOLDR_AGENT_TOKENS;
    const req = new Request('http://localhost/mcp', { method: 'POST' });
    expect(authenticate(req)).toBe('anonymous');
  });

  test('valid shared Bearer token resolves the default principal', () => {
    process.env.KNOLDR_API_TOKEN = 'test-secret-123';
    delete process.env.KNOLDR_AGENT_TOKENS;
    const req = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-secret-123' },
    });
    expect(authenticate(req)).toBe('default');
  });

  test('per-agent token resolves to that agent id', () => {
    delete process.env.KNOLDR_API_TOKEN;
    process.env.KNOLDR_AGENT_TOKENS = 'alice:tok_alice,bob:tok_bob';
    const req = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok_bob' },
    });
    expect(authenticate(req)).toBe('bob');
  });

  test('rejects missing Authorization header', () => {
    process.env.KNOLDR_API_TOKEN = 'test-secret-123';
    const req = new Request('http://localhost/mcp', { method: 'POST' });
    expect(authenticate(req)).toBeNull();
  });

  test('rejects wrong token', () => {
    process.env.KNOLDR_API_TOKEN = 'test-secret-123';
    const req = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(authenticate(req)).toBeNull();
  });

  test('rejects non-Bearer scheme', () => {
    process.env.KNOLDR_API_TOKEN = 'test-secret-123';
    const req = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { Authorization: 'Basic dGVzdDp0ZXN0' },
    });
    expect(authenticate(req)).toBeNull();
  });

  test('case-insensitive Bearer scheme', () => {
    process.env.KNOLDR_API_TOKEN = 'test-secret-123';
    const req = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { Authorization: 'bearer test-secret-123' },
    });
    expect(authenticate(req)).toBe('default');
  });
});
