// Multi-source independence detection.
//
// Five sources all supporting a claim look strong, but if they're
// five reposts of the same Reuters wire story they're really one
// source — N copies do not count as N independent corroborations.
// We deduplicate at three layers:
//
// 1. Domain — different reg-domain, different publisher (already
//    enforced when web-search assembles candidates).
// 2. Title — different titles after normalization (catches Medium
//    cross-posts of the exact same article).
// 3. Content simhash — same body text under different titles
//    (catches AP/Reuters wires republished with a fresh headline).

const SHINGLE_LEN = 8;
const HASH_BITS = 64;

export interface SourceFingerprint {
  url: string;
  domain: string;
  titleNorm: string;
  simhash: bigint;
}

export function fingerprint(url: string, title: string, text: string): SourceFingerprint {
  let domain = "";
  try {
    domain = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch { /* malformed URL */ }
  return {
    url,
    domain,
    titleNorm: normalize(title),
    simhash: simhash(text.slice(0, 8000)),
  };
}

/**
 * Group fingerprints into independence buckets. Two fingerprints
 * collapse if any of: same domain, same normalized title, hamming
 * distance < 4 on simhash. Uses union-find so similarity is
 * transitive — A~B and B~C imply A~C even when A and C aren't
 * directly similar (catches three-way cascades of Reuters reposts
 * that the per-group-head comparison dropped into separate buckets).
 */
export function independentCount(fps: SourceFingerprint[]): number {
  if (fps.length === 0) return 0;
  const parent = fps.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let i = 0; i < fps.length; i++) {
    for (let j = i + 1; j < fps.length; j++) {
      const fi = fps[i]!;
      const fj = fps[j]!;
      if (
        (fi.domain && fi.domain === fj.domain) ||
        (fi.titleNorm.length > 4 && fi.titleNorm === fj.titleNorm) ||
        hamming(fi.simhash, fj.simhash) < 4
      ) {
        union(i, j);
      }
    }
  }
  const roots = new Set<number>();
  for (let i = 0; i < fps.length; i++) roots.add(find(i));
  return roots.size;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * 64-bit simhash over word shingles. Cheap, stable across whitespace,
 * good enough to flag obvious wire-story duplicates.
 */
function simhash(text: string): bigint {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length < SHINGLE_LEN) return 0n;
  const counts = new Array<number>(HASH_BITS).fill(0);
  for (let i = 0; i <= tokens.length - SHINGLE_LEN; i++) {
    const shingle = tokens.slice(i, i + SHINGLE_LEN).join(" ");
    const h = fnv64(shingle);
    for (let b = 0; b < HASH_BITS; b++) {
      const bit = (h >> BigInt(b)) & 1n;
      counts[b] = (counts[b] ?? 0) + (bit === 1n ? 1 : -1);
    }
  }
  let out = 0n;
  for (let b = 0; b < HASH_BITS; b++) {
    if (counts[b]! > 0) out |= 1n << BigInt(b);
  }
  return out;
}

function fnv64(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h;
}

function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x !== 0n) {
    x &= x - 1n;
    count++;
  }
  return count;
}
