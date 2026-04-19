import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { generateEmbedding } from "../ingest/embed";
import { rerank } from "../llm/reranker";
import { logger } from "../observability/logger";

// Per-fetch budget. Most pages render under 5s; the few that don't
// (paywalls, JS-only, dead) we'd rather give up on than block the
// verify worker. NLI handles "no source text" by returning low
// entailment, which is the right outcome for unfetchable sources.
const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const USER_AGENT =
  process.env.KNOLDR_FETCH_USER_AGENT ??
  "Mozilla/5.0 (compatible; knoldr-verifier/0.3; +https://github.com/parkrevil)";

export interface FetchedSource {
  url: string;
  status: "ok" | "fetch_failed" | "no_content" | "blocked_type";
  title?: string;
  text?: string;
  byline?: string;
  publishedTime?: string;
  lang?: string;
  fetchedAt: Date;
  error?: string;
}

/**
 * Fetch a URL and extract the main readable body via Readability.
 * Returns text suitable for NLI premise input; never throws.
 */
export async function fetchSource(url: string): Promise<FetchedSource> {
  const fetchedAt = new Date();
  const ctrl = AbortSignal.timeout(FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: ctrl,
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
    });

    if (!res.ok) {
      return { url, status: "fetch_failed", fetchedAt, error: `HTTP ${res.status}` };
    }

    const ct = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(ct)) {
      // PDF, plain text, JSON etc. — Readability won't help. Could add
      // pdf.js later; for now treat as unfetchable so NLI returns neutral.
      return { url, status: "blocked_type", fetchedAt, error: `content-type ${ct}` };
    }

    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BODY_BYTES) {
      return { url, status: "blocked_type", fetchedAt, error: "body too large" };
    }
    const html = new TextDecoder("utf-8", { fatal: false }).decode(buf);

    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    if (!article || !article.textContent || article.textContent.trim().length < 100) {
      return { url, status: "no_content", fetchedAt, error: "readability returned empty" };
    }

    return {
      url,
      status: "ok",
      title: article.title ?? undefined,
      text: normalizeWhitespace(article.textContent),
      byline: article.byline ?? undefined,
      publishedTime: article.publishedTime ?? undefined,
      lang: article.lang ?? undefined,
      fetchedAt,
    };
  } catch (err) {
    const msg = (err as Error).message;
    logger.debug({ url, error: msg }, "source fetch failed");
    return { url, status: "fetch_failed", fetchedAt, error: msg };
  }
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Return the top-K chunks of `text` most relevant to `claim`. Two
 * stages:
 *   1. Dual-encoder cosine pre-filter on all chunks (cheap, ~10ms
 *      each). Drops obviously irrelevant chunks down to a candidate
 *      pool of ~3×K.
 *   2. Cross-encoder reranker (bge-reranker-base) on the candidates.
 *      A cross-encoder evaluates the (claim, chunk) pair jointly,
 *      which catches "mentions the entity but contradicts the claim"
 *      cases that the dual-encoder misranks because both sentences
 *      embed near the same point.
 */
export async function selectRelevantChunks(
  text: string,
  claim: string,
  topK = 6,
  chunkChars = 400,
): Promise<string[]> {
  const chunks = chunkBySentences(text, chunkChars);
  if (chunks.length === 0) return [text];
  if (chunks.length <= topK) return chunks;

  // Stage 1: dual-encoder shortlist — keep top 3×K by cosine.
  const claimVec = await generateEmbedding(claim);
  const scored: Array<{ idx: number; score: number }> = [];
  for (let i = 0; i < chunks.length; i++) {
    const v = await generateEmbedding(chunks[i]!);
    scored.push({ idx: i, score: cosine(claimVec, v) });
  }
  scored.sort((a, b) => b.score - a.score);
  const shortlistSize = Math.min(scored.length, topK * 3);
  const shortlist = scored.slice(0, shortlistSize).map((s) => chunks[s.idx]!);

  // Stage 2: cross-encoder rerank for claim-conditional relevance.
  const order = await rerank(claim, shortlist);
  return order.slice(0, topK).map((i) => shortlist[i]!);
}

function chunkBySentences(text: string, targetChars: number): string[] {
  const sentences = text.split(/(?<=[.!?。!?])\s+/);
  const chunks: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (buf.length + s.length + 1 > targetChars && buf.length > 0) {
      chunks.push(buf);
      buf = "";
    }
    buf = buf ? `${buf} ${s}` : s;
    if (buf.length >= targetChars) {
      chunks.push(buf);
      buf = "";
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}
