import { describe, test, expect } from 'bun:test';

import { handleFeedback } from '../../src/mcp/handlers/feedback';

// Identity is server-derived (passed as the second arg), no longer a
// trusted input field — so there is no "missing agentId" input case.
const CALLER = 'test-agent';

describe('handleFeedback — input validation (no DB)', () => {
  test('missing entryId returns invalid_input', async () => {
    const res = await handleFeedback({ signal: 'positive' }, CALLER);
    expect(res).toEqual(expect.objectContaining({ ok: false, error: 'invalid_input' }));
  });

  test('invalid signal returns invalid_input', async () => {
    const res = await handleFeedback({ entryId: '01ABC', signal: 'maybe' }, CALLER);
    expect(res).toEqual(expect.objectContaining({ ok: false, error: 'invalid_input' }));
  });

  test('empty entryId returns invalid_input', async () => {
    const res = await handleFeedback({ entryId: '', signal: 'positive' }, CALLER);
    expect(res).toEqual(expect.objectContaining({ ok: false, error: 'invalid_input' }));
  });

  test('reason exceeding max length returns invalid_input', async () => {
    const res = await handleFeedback({ entryId: '01ABC', signal: 'positive', reason: 'x'.repeat(1001) }, CALLER);
    expect(res).toEqual(expect.objectContaining({ ok: false, error: 'invalid_input' }));
  });
});
