import { logger } from "../../observability/logger";

interface RssItem {
  title: string;
  link: string;
  description: string;
}

/** Parse RSS/Atom feed XML and extract items */
export async function fetchRss(url: string): Promise<RssItem[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`RSS fetch failed ${res.status}: ${url}`);

  const xml = await res.text();
  const items: RssItem[] = [];

  // Simple XML parsing for RSS <item> and Atom <entry>
  // RSS items
  const rssItems = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  for (const itemXml of rssItems) {
    const title = extractTag(itemXml, "title");
    const link = extractTag(itemXml, "link");
    const description = extractTag(itemXml, "description") || extractTag(itemXml, "content:encoded");
    if (title && link) {
      items.push({ title, link, description: stripCdata(description ?? "") });
    }
  }

  // Atom entries
  if (items.length === 0) {
    const atomEntries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
    for (const entryXml of atomEntries) {
      const title = extractTag(entryXml, "title");
      const link = extractAtomLink(entryXml);
      const description = extractTag(entryXml, "summary") || extractTag(entryXml, "content");
      if (title && link) {
        items.push({ title, link, description: stripCdata(description ?? "") });
      }
    }
  }

  logger.debug({ url, itemCount: items.length }, "RSS/Atom feed parsed");
  return items;
}

function extractTag(xml: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const match = xml.match(regex);
  return match ? match[1]!.trim() : null;
}

function extractAtomLink(xml: string): string | null {
  const match = xml.match(/<link[^>]*href="([^"]*)"[^>]*>/i);
  return match ? match[1]! : null;
}

function stripCdata(text: string): string {
  return text
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/<[^>]*>/g, "")
    .trim();
}
