interface HnItem {
  id: number;
  title: string;
  url?: string;
  score: number;
}

/** Fetch top HN stories (score >= 50) */
export async function fetchHnTopStories(limit = 30): Promise<HnItem[]> {
  const res = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json");
  if (!res.ok) throw new Error(`HN API error ${res.status}`);

  const ids = (await res.json()) as number[];
  const topIds = ids.slice(0, limit);

  const items: HnItem[] = [];
  for (const id of topIds) {
    const itemRes = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
    if (!itemRes.ok) continue;

    const item = (await itemRes.json()) as {
      id: number;
      title?: string;
      url?: string;
      score?: number;
    };

    if (item.title && (item.score ?? 0) >= 50) {
      items.push({
        id: item.id,
        title: item.title,
        url: item.url,
        score: item.score ?? 0,
      });
    }
  }

  return items;
}

/** Fetch content from URL via Jina Reader */
async function jinaFetch(url: string, apiKey: string): Promise<string | null> {
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "text/plain" },
    });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

export async function hnToRaw(
  item: HnItem,
  jinaApiKey?: string,
): Promise<{ raw: string; sources: Array<{ url: string; sourceType: string }> }> {
  let content = "";

  if (item.url && jinaApiKey) {
    content = (await jinaFetch(item.url, jinaApiKey)) ?? "";
  }

  return {
    raw: content ? `${item.title}\n\n${content}` : item.title,
    sources: [
      {
        url: `https://news.ycombinator.com/item?id=${item.id}`,
        sourceType: "community_forum",
      },
    ],
  };
}
