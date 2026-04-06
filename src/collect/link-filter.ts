import { logger } from "../observability/logger";

function extractJsonFromOutput(text: string): unknown {
  try { return JSON.parse(text); } catch { /* ignore */ }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]!.trim()); } catch { /* ignore */ } }
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s !== -1 && e > s) { try { return JSON.parse(text.slice(s, e + 1)); } catch { /* ignore */ } }
  return {};
}

function getGeminiCli() {
  return process.env.KNOLDR_GEMINI_CLI ?? "gemini";
}

// Extensions to always skip
const SKIP_EXTENSIONS = new Set([
  ".css", ".js", ".woff", ".woff2", ".ttf", ".eot", ".ico",
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", // images handled separately by content-type
  ".mp3", ".mp4", ".avi", ".mov", ".wmv", ".flv",
  ".zip", ".tar", ".gz", ".rar", ".7z",
  ".exe", ".dmg", ".msi", ".deb", ".rpm",
]);

// URL path patterns to always skip
const SKIP_PATTERNS = [
  /\/login\b/i, /\/signup\b/i, /\/register\b/i, /\/cart\b/i,
  /\/account\b/i, /\/checkout\b/i, /\/password\b/i, /\/oauth\b/i,
  /\/admin\b/i, /\/wp-admin\b/i, /\/feed\b/i, /\/rss\b/i,
  /\/print\b/i, /\/share\b/i, /\/mailto:/i,
  /\.(css|js|woff2?|ttf|eot|ico)(\?|$)/i,
];

/**
 * Rule-based pre-filter: cheap, runs first. Returns links that pass.
 */
export function preFilterLinks(
  links: string[],
  visitedUrls: Set<string>,
  currentDomain: string,
): { sameDomain: string[]; external: string[] } {
  const sameDomain: string[] = [];
  const external: string[] = [];
  const seen = new Set<string>();

  for (const link of links) {
    // Skip visited
    if (visitedUrls.has(link)) continue;

    // Skip anchors only
    try {
      const url = new URL(link);

      // Skip non-http
      if (!url.protocol.startsWith("http")) continue;

      // Normalize: strip hash/anchor
      url.hash = "";
      const normalized = url.href;
      if (visitedUrls.has(normalized) || seen.has(normalized)) continue;
      seen.add(normalized);

      // Skip extensions
      const ext = url.pathname.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase();
      if (ext && SKIP_EXTENSIONS.has(ext)) continue;

      // Skip patterns
      if (SKIP_PATTERNS.some((p) => p.test(url.pathname))) continue;

      // Classify (use normalized URL without hash)
      if (url.hostname === currentDomain || url.hostname.endsWith(`.${currentDomain}`)) {
        sameDomain.push(normalized);
      } else {
        external.push(normalized);
      }
    } catch {
      continue; // Invalid URL
    }
  }

  return { sameDomain, external };
}

/**
 * LLM-based link selection: expensive, runs after pre-filter.
 * Selects top N links most likely to contain relevant information.
 */
export async function llmSelectLinks(
  links: string[],
  topic: string,
  maxLinks: number,
): Promise<string[]> {
  if (links.length === 0) return [];
  if (links.length <= maxLinks) return links;

  const cliParts = getGeminiCli().split(/\s+/);
  const linkList = links.map((l, i) => `${i}: ${l}`).join("\n");
  const prompt = `You are a link relevance filter. Given a research topic and a list of URLs, select the ${maxLinks} URLs most likely to contain useful information about the topic.

Topic: ${topic}

URLs:
${linkList}

Respond with JSON only: { "selected": [0, 3, 7, ...] } (indices of selected URLs)`;

  try {
    const proc = Bun.spawn([...cliParts, "-p", prompt], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      // Fallback: return first N
      return links.slice(0, maxLinks);
    }

    const json = extractJsonFromOutput(stdout) as { selected?: number[] };
    if (!json.selected || !Array.isArray(json.selected)) {
      return links.slice(0, maxLinks);
    }

    return json.selected
      .filter((i) => typeof i === "number" && i >= 0 && i < links.length)
      .slice(0, maxLinks)
      .map((i) => links[i]!);
  } catch (err) {
    logger.debug({ error: (err as Error).message }, "LLM link selection failed, using first N");
    return links.slice(0, maxLinks);
  }
}
