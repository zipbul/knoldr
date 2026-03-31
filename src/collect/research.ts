import { ingest } from "../ingest/engine";
import { parseStoreInput } from "../ingest/validate";
import { logger } from "../observability/logger";

function getResearchConfig() {
  return {
    googleApiKey: process.env.KNOLDR_GOOGLE_API_KEY,
    googleCseId: process.env.KNOLDR_GOOGLE_CSE_ID,
    youtubeApiKey: process.env.KNOLDR_YOUTUBE_API_KEY,
    llmApiKey: process.env.KNOLDR_LLM_API_KEY,
    llmBaseUrl: process.env.KNOLDR_LLM_BASE_URL ?? "https://api.anthropic.com",
    llmModel: process.env.KNOLDR_LLM_MODEL ?? "claude-haiku-4-5-20251001",
  };
}

interface ResearchInput {
  topic: string;
  domain?: string;
  maxEntries?: number;
  includeYoutube?: boolean;
}

export interface ResearchResult {
  entries: Array<{ entryId: string; action: string }>;
  status: "completed" | "partial";
}

// ============================================================
// 1. LLM Query Generation
// ============================================================
async function generateQueries(topic: string): Promise<string[]> {
  const { llmApiKey, llmBaseUrl, llmModel } = getResearchConfig();
  if (!llmApiKey) throw new Error("KNOLDR_LLM_API_KEY required for research");

  const res = await fetch(`${llmBaseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": llmApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: llmModel,
      max_tokens: 512,
      tools: [
        {
          name: "search_queries",
          description: "Generate diverse search queries for research",
          input_schema: {
            type: "object",
            properties: {
              queries: {
                type: "array",
                items: { type: "string" },
                minItems: 3,
                maxItems: 5,
              },
            },
            required: ["queries"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "search_queries" },
      messages: [
        {
          role: "user",
          content: `Generate 3-5 diverse search queries to research: ${topic}`,
        },
      ],
    }),
  });

  if (!res.ok) throw new Error(`LLM API error ${res.status}: ${await res.text()}`);

  const json = (await res.json()) as {
    content: Array<{ type: string; name?: string; input?: { queries?: string[] } }>;
  };
  const toolUse = json.content.find((b) => b.type === "tool_use" && b.name === "search_queries");
  return toolUse?.input?.queries ?? [`${topic} overview`, `${topic} latest`];
}

// ============================================================
// 2. Google Custom Search
// ============================================================
interface GoogleSearchResult {
  title: string;
  link: string;
  snippet: string;
}

async function googleSearch(query: string): Promise<GoogleSearchResult[]> {
  const { googleApiKey, googleCseId } = getResearchConfig();
  if (!googleApiKey || !googleCseId) {
    throw new Error("KNOLDR_GOOGLE_API_KEY and KNOLDR_GOOGLE_CSE_ID required for research");
  }

  const params = new URLSearchParams({
    key: googleApiKey,
    cx: googleCseId,
    q: query,
    num: "10",
  });

  const res = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);
  if (!res.ok) throw new Error(`Google Search API error ${res.status}: ${await res.text()}`);

  const json = (await res.json()) as {
    items?: Array<{ title: string; link: string; snippet: string }>;
  };

  return (json.items ?? []).map((item) => ({
    title: item.title,
    link: item.link,
    snippet: item.snippet,
  }));
}

// ============================================================
// 3. Content Extraction (Playwright + Readability)
// ============================================================
async function extractContent(url: string): Promise<string | null> {
  try {
    const { chromium } = await import("playwright");
    const { Readability } = await import("@mozilla/readability");
    const { parseHTML } = await import("linkedom");

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    // Wait for dynamic content
    await page.waitForTimeout(2000);

    const html = await page.content();
    await browser.close();

    // Extract article content with Readability
    const { document } = parseHTML(html);
    const reader = new Readability(document);
    const article = reader.parse();

    if (!article?.textContent || article.textContent.length < 100) {
      return null;
    }

    return article.textContent.trim();
  } catch (err) {
    logger.debug({ url, error: (err as Error).message }, "content extraction failed");
    return null;
  }
}

// ============================================================
// 4. YouTube Search + Transcript
// ============================================================
interface YouTubeResult {
  videoId: string;
  title: string;
  transcript: string;
}

async function youtubeSearch(query: string, maxResults = 5): Promise<YouTubeResult[]> {
  const { youtubeApiKey } = getResearchConfig();
  if (!youtubeApiKey) return [];

  // Search videos
  const searchParams = new URLSearchParams({
    key: youtubeApiKey,
    q: query,
    type: "video",
    part: "snippet",
    maxResults: String(maxResults),
    videoCaption: "closedCaption", // only videos with captions
  });

  const searchRes = await fetch(
    `https://www.googleapis.com/youtube/v3/search?${searchParams}`,
  );
  if (!searchRes.ok) return [];

  const searchJson = (await searchRes.json()) as {
    items?: Array<{ id: { videoId: string }; snippet: { title: string } }>;
  };

  const results: YouTubeResult[] = [];

  for (const item of searchJson.items ?? []) {
    const videoId = item.id.videoId;
    const title = item.snippet.title;

    // Fetch transcript
    const transcript = await fetchYoutubeTranscript(videoId);
    if (transcript) {
      results.push({ videoId, title, transcript });
    }
  }

  return results;
}

async function fetchYoutubeTranscript(videoId: string): Promise<string | null> {
  try {
    // YouTube transcript via innertube API (no OAuth needed)
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
    if (!res.ok) return null;

    const html = await res.text();

    // Extract captions URL from page source
    const captionsMatch = html.match(/"captionTracks":\[(.+?)\]/);
    if (!captionsMatch) return null;

    const captionsJson = JSON.parse(`[${captionsMatch[1]}]`) as Array<{
      baseUrl: string;
      languageCode: string;
    }>;

    // Prefer English, fallback to first available
    const track =
      captionsJson.find((c) => c.languageCode === "en") ?? captionsJson[0];
    if (!track?.baseUrl) return null;

    // Fetch transcript XML
    const transcriptRes = await fetch(track.baseUrl);
    if (!transcriptRes.ok) return null;

    const transcriptXml = await transcriptRes.text();

    // Extract text from <text> tags
    const texts = transcriptXml.match(/<text[^>]*>([\s\S]*?)<\/text>/g);
    if (!texts) return null;

    return texts
      .map((t) =>
        t
          .replace(/<[^>]*>/g, "")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&#39;/g, "'")
          .replace(/&quot;/g, '"'),
      )
      .join(" ")
      .trim();
  } catch {
    return null;
  }
}

// ============================================================
// 5. Research Orchestration
// ============================================================
export async function research(input: ResearchInput): Promise<ResearchResult> {
  const maxEntries = Math.min(input.maxEntries ?? 30, 50);
  const deadline = Date.now() + 5 * 60 * 1000; // 5 min timeout
  const allResults: Array<{ entryId: string; action: string }> = [];
  const seenUrls = new Set<string>();

  logger.info({ topic: input.topic, maxEntries }, "research started");

  // Step 1: Generate queries
  let queries: string[];
  try {
    queries = await generateQueries(input.topic);
  } catch (err) {
    logger.error({ error: (err as Error).message }, "failed to generate research queries");
    return { entries: [], status: "partial" };
  }

  logger.info({ queries }, "research queries generated");

  // Step 2: Web search + content extraction
  for (const query of queries) {
    if (Date.now() > deadline || allResults.length >= maxEntries) break;

    let searchResults: GoogleSearchResult[];
    try {
      searchResults = await googleSearch(query);
    } catch (err) {
      logger.warn({ query, error: (err as Error).message }, "google search failed");
      continue;
    }

    for (const result of searchResults) {
      if (Date.now() > deadline || allResults.length >= maxEntries) break;
      if (seenUrls.has(result.link)) continue;
      seenUrls.add(result.link);

      // Extract content via Playwright + Readability
      const content = await extractContent(result.link);
      if (!content || content.length < 100) continue;

      const raw = `${result.title}\n\n${content}`;
      const sourceType = estimateSourceType(result.link);

      try {
        const storeInput = parseStoreInput({
          raw: raw.slice(0, 200_000),
          sources: [{ url: result.link, sourceType }],
        });
        const ingestResults = await ingest(storeInput);
        for (const r of ingestResults) {
          allResults.push({ entryId: r.entryId, action: r.action });
        }
      } catch (err) {
        logger.warn({ url: result.link, error: (err as Error).message }, "ingestion failed");
      }
    }
  }

  // Step 3: YouTube search + transcript (if enabled)
  if (input.includeYoutube !== false && Date.now() < deadline && allResults.length < maxEntries) {
    for (const query of queries.slice(0, 2)) {
      if (Date.now() > deadline || allResults.length >= maxEntries) break;

      const videos = await youtubeSearch(query, 3);
      for (const video of videos) {
        if (Date.now() > deadline || allResults.length >= maxEntries) break;

        const raw = `${video.title}\n\n${video.transcript}`;
        const url = `https://www.youtube.com/watch?v=${video.videoId}`;

        try {
          const storeInput = parseStoreInput({
            raw: raw.slice(0, 200_000),
            sources: [{ url, sourceType: "community_forum" }],
          });
          const ingestResults = await ingest(storeInput);
          for (const r of ingestResults) {
            allResults.push({ entryId: r.entryId, action: r.action });
          }
        } catch (err) {
          logger.warn({ videoId: video.videoId, error: (err as Error).message }, "youtube ingestion failed");
        }
      }
    }
  }

  const status = Date.now() > deadline ? "partial" : "completed";
  logger.info({ topic: input.topic, resultCount: allResults.length, status }, "research finished");

  return { entries: allResults, status };
}

function estimateSourceType(url: string): string {
  if (url.includes("github.com")) return "github_release";
  if (url.includes("arxiv.org")) return "research_paper";
  if (url.includes(".gov") || url.includes(".edu")) return "official_docs";
  if (url.includes("medium.com") || url.includes("dev.to")) return "established_blog";
  if (url.includes("stackoverflow.com") || url.includes("reddit.com")) return "community_forum";
  return "unknown";
}
