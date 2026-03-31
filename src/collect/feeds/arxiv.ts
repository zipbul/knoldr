import { fetchRss } from "./rss";

interface ArxivPaper {
  title: string;
  summary: string;
  url: string;
}

/** Fetch recent arXiv papers via Atom feed */
export async function fetchArxiv(category: string, maxResults = 20): Promise<ArxivPaper[]> {
  // arXiv API returns Atom XML
  const url = `http://export.arxiv.org/api/query?search_query=cat:${category}&sortBy=submittedDate&sortOrder=descending&max_results=${maxResults}`;
  const items = await fetchRss(url);

  return items.map((item) => ({
    title: item.title.replace(/\s+/g, " ").trim(),
    summary: item.description.replace(/\s+/g, " ").trim(),
    url: item.link,
  }));
}

export function arxivToRaw(paper: ArxivPaper): {
  raw: string;
  sources: Array<{ url: string; sourceType: string }>;
} {
  return {
    raw: `${paper.title}\n\n${paper.summary}`,
    sources: [{ url: paper.url, sourceType: "research_paper" }],
  };
}
