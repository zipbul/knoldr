export interface RawRow {
  id: string;
  title: string;
  content: string;
  language: string;
  metadata: unknown;
  authority: number;
  decayRate: number;
  status: string;
  createdAt: Date;
  pgroongaScore: number;
  domains: string[];
  tags: string[];
  sources: Array<{ url: string; sourceType: string; trust: number }>;
}

export interface ScoredEntry {
  id: string;
  title: string;
  content: string;
  language: string;
  metadata: unknown;
  authority: number;
  decayRate: number;
  status: string;
  createdAt: string; // ISO string
  domains: string[];
  tags: string[];
  sources: Array<{ url: string; sourceType: string; trust: number }>;
}

export interface ScoreBreakdown {
  relevance: number;
  authority: number;
  freshness: number;
  final: number;
}

export interface RankResult {
  entries: ScoredEntry[];
  scores: ScoreBreakdown[];
  trustLevels: string[];
}

/**
 * Rank search/explore results.
 *
 * Query mode:  final = relevance * 0.5 + authority * 0.2 + freshness * 0.3
 * Explore mode: final = authority * 0.4 + freshness * 0.6 (no relevance)
 */
export function rank(rows: RawRow[], mode: "query" | "explore"): RankResult {
  if (rows.length === 0) {
    return { entries: [], scores: [], trustLevels: [] };
  }

  const now = Date.now();

  // Min-max normalize pgroonga scores (per-query, not global)
  const rawScores = rows.map((r) => r.pgroongaScore);
  const minScore = Math.min(...rawScores);
  const maxScore = Math.max(...rawScores);
  const scoreRange = maxScore - minScore;

  const scored = rows.map((row) => {
    const relevance =
      mode === "explore"
        ? 0
        : scoreRange === 0
          ? 1.0
          : (row.pgroongaScore - minScore) / scoreRange;

    const authority = row.authority;
    const daysSinceCreation = (now - row.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    const freshness = Math.exp(-row.decayRate * daysSinceCreation);

    const final =
      mode === "query"
        ? relevance * 0.5 + authority * 0.2 + freshness * 0.3
        : authority * 0.4 + freshness * 0.6;

    const trustLevel = getTrustLevel(authority);

    return {
      entry: {
        id: row.id,
        title: row.title,
        content: row.content,
        language: row.language,
        metadata: row.metadata,
        authority: row.authority,
        decayRate: row.decayRate,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        domains: row.domains,
        tags: row.tags,
        sources: row.sources,
      },
      score: { relevance, authority, freshness, final },
      trustLevel,
    };
  });

  // Sort by final score descending, then id descending
  scored.sort((a, b) => b.score.final - a.score.final || b.entry.id.localeCompare(a.entry.id));

  return {
    entries: scored.map((s) => s.entry),
    scores: scored.map((s) => s.score),
    trustLevels: scored.map((s) => s.trustLevel),
  };
}

function getTrustLevel(authority: number): string {
  if (authority >= 0.7) return "high";
  if (authority >= 0.4) return "medium";
  return "low";
}
