import type { Source } from "../ingest/validate";

export const SOURCE_TYPE_SCORES: Record<string, number> = {
  official_docs: 0.9,
  github_release: 0.85,
  cve_db: 0.9,
  official_blog: 0.8,
  research_paper: 0.75,
  established_blog: 0.6,
  community_forum: 0.4,
  personal_blog: 0.3,
  ai_generated: 0.2,
  unknown: 0.1,
};

/** Get trust score for a source, always rule-based from sourceType. Caller-supplied trust is ignored. */
export function getSourceTrust(sourceType: string): number {
  return SOURCE_TYPE_SCORES[sourceType] ?? 0.1;
}

/**
 * Calculate authority score from sources (rule-based, $0).
 * Multiple sources: max * 0.8 + avg * 0.2
 * No sources: 0.1
 */
export function calculateAuthority(sources: Source[]): number {
  if (sources.length === 0) return 0.1;

  const scores = sources.map((s) => getSourceTrust(s.sourceType));

  if (scores.length === 1) return scores[0]!;

  const max = Math.max(...scores);
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;

  return max * 0.8 + avg * 0.2;
}
