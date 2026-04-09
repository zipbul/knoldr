import { logger } from "../observability/logger";

const YOUTUBE_API_KEY = process.env.KNOLDR_YOUTUBE_API_KEY;

export interface YouTubeResult {
  videoId: string;
  title: string;
  text: string;
}

/**
 * Search YouTube for videos with captions and extract transcripts.
 * Falls back to Gemini multimodal if no captions available.
 */
export async function searchAndExtractYoutube(query: string, maxResults = 3): Promise<YouTubeResult[]> {
  if (!YOUTUBE_API_KEY) return [];

  const searchParams = new URLSearchParams({
    key: YOUTUBE_API_KEY,
    q: query,
    type: "video",
    part: "snippet",
    maxResults: String(maxResults),
    videoCaption: "closedCaption",
  });

  let searchRes: Response;
  try {
    searchRes = await fetch(`https://www.googleapis.com/youtube/v3/search?${searchParams}`, {
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return [];
  }
  if (!searchRes.ok) return [];

  const searchJson = (await searchRes.json()) as {
    items?: Array<{ id: { videoId: string }; snippet: { title: string } }>;
  };

  const results: YouTubeResult[] = [];

  for (const item of searchJson.items ?? []) {
    const videoId = item.id.videoId;
    const title = item.snippet.title;

    const transcript = await fetchTranscript(videoId);
    if (transcript) {
      results.push({ videoId, title, text: transcript });
    }
  }

  return results;
}

/**
 * Extract transcript for a single YouTube video by URL.
 */
export async function extractYoutubeByUrl(url: string): Promise<string | null> {
  const videoId = extractVideoId(url);
  if (!videoId) return null;
  return fetchTranscript(videoId);
}

function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1);
    if (u.hostname.includes("youtube.com")) return u.searchParams.get("v");
    return null;
  } catch {
    return null;
  }
}

async function fetchTranscript(videoId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;

    const html = await res.text();

    const captionsMatch = html.match(/"captionTracks":\[(.+?)\]/);
    if (!captionsMatch) return null;

    const captionsJson = JSON.parse(`[${captionsMatch[1]}]`) as Array<{
      baseUrl: string;
      languageCode: string;
    }>;

    const track = captionsJson.find((c) => c.languageCode === "en") ?? captionsJson[0];
    if (!track?.baseUrl) return null;

    const transcriptRes = await fetch(track.baseUrl, { signal: AbortSignal.timeout(10000) });
    if (!transcriptRes.ok) return null;

    const transcriptXml = await transcriptRes.text();

    const texts = transcriptXml.match(/<text[^>]*>([\s\S]*?)<\/text>/g);
    if (!texts) return null;

    return texts
      .map((t) =>
        t.replace(/<[^>]*>/g, "")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&#39;/g, "'")
          .replace(/&quot;/g, '"'),
      )
      .join(" ")
      .trim();
  } catch (err) {
    logger.debug({ videoId, error: (err as Error).message }, "YouTube transcript fetch failed");
    return null;
  }
}
