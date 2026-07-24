// Shared once-only loader for expensive model handles.
//
// The naive pattern — stash the in-flight promise in a `loading` map —
// has a poisoning failure mode: if the load REJECTS, the rejected
// promise stays in the map and every later caller receives the same
// rejection until process restart (one cold-start network blip killed
// verification permanently). This helper clears the in-flight slot on
// settle, so a failed load is retried by the next caller while
// concurrent callers still share a single attempt and successes cache
// forever.

export async function loadOnce<T>(
  cache: Map<string, T>,
  loading: Map<string, Promise<T>>,
  key: string,
  factory: () => Promise<T>,
): Promise<T> {
  const hit = cache.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const inFlight = loading.get(key);
  if (inFlight) {
    return inFlight;
  }
  const promise = (async () => {
    const value = await factory();
    cache.set(key, value);
    return value;
  })();
  loading.set(key, promise);
  try {
    return await promise;
  } finally {
    loading.delete(key);
  }
}
