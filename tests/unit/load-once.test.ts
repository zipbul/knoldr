// P0 regression: model loaders cached the in-flight promise in a
// `loading` map but never removed it on REJECTION — one cold-start
// failure (network blip, OOM) poisoned the map and every later call
// returned the same rejected promise until process restart, killing
// verification permanently. `loadOnce` is the shared fixed helper.

import { describe, test, expect } from 'bun:test';

import { loadOnce } from '../../src/llm/load-once';

describe('loadOnce', () => {
  test('caches a successful load — factory runs once', async () => {
    const cache = new Map<string, number>();
    const loading = new Map<string, Promise<number>>();
    let calls = 0;
    const factory = async () => {
      calls++;
      return 42;
    };
    const a = await loadOnce(cache, loading, 'm', factory);
    const b = await loadOnce(cache, loading, 'm', factory);
    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(calls).toBe(1);
  });

  test('concurrent callers share one in-flight load', async () => {
    const cache = new Map<string, string>();
    const loading = new Map<string, Promise<string>>();
    let calls = 0;
    const factory = async () => {
      calls++;
      await new Promise(r => setTimeout(r, 20));
      return 'handles';
    };
    const [a, b] = await Promise.all([loadOnce(cache, loading, 'm', factory), loadOnce(cache, loading, 'm', factory)]);
    expect(a).toBe('handles');
    expect(b).toBe('handles');
    expect(calls).toBe(1);
  });

  test('a FAILED load is retried on the next call (no permanent poisoning)', async () => {
    const cache = new Map<string, string>();
    const loading = new Map<string, Promise<string>>();
    let calls = 0;
    const factory = async () => {
      calls++;
      if (calls === 1) {
        throw new Error('cold-start network blip');
      }
      return 'recovered';
    };
    await (expect(loadOnce(cache, loading, 'm', factory)).rejects.toThrow('cold-start network blip') as unknown as Promise<void>);
    // The rejected promise must NOT remain in the loading map.
    expect(loading.size).toBe(0);
    const second = await loadOnce(cache, loading, 'm', factory);
    expect(second).toBe('recovered');
    expect(calls).toBe(2);
  });
});
