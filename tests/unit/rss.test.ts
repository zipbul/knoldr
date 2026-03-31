import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { fetchRss } from "../../src/collect/feeds/rss";

let mockServer: ReturnType<typeof Bun.serve>;

const RSS_XML = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <item>
      <title>First Article</title>
      <link>https://example.com/article1</link>
      <description>Description of first article</description>
    </item>
    <item>
      <title>Second Article</title>
      <link>https://example.com/article2</link>
      <description><![CDATA[Description with <b>HTML</b>]]></description>
    </item>
  </channel>
</rss>`;

const ATOM_XML = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <entry>
    <title>Atom Entry</title>
    <link href="https://example.com/atom1"/>
    <summary>Atom summary</summary>
  </entry>
</feed>`;

beforeAll(() => {
  mockServer = Bun.serve({
    port: 19970,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/rss") return new Response(RSS_XML, { headers: { "Content-Type": "application/xml" } });
      if (path === "/atom") return new Response(ATOM_XML, { headers: { "Content-Type": "application/xml" } });
      if (path === "/empty") return new Response("<rss><channel></channel></rss>");
      return new Response("Not Found", { status: 404 });
    },
  });
});

afterAll(() => mockServer.stop());

describe("fetchRss", () => {
  test("parses RSS feed items", async () => {
    const items = await fetchRss("http://localhost:19970/rss");
    expect(items).toHaveLength(2);
    expect(items[0]!.title).toBe("First Article");
    expect(items[0]!.link).toBe("https://example.com/article1");
    expect(items[0]!.description).toBe("Description of first article");
  });

  test("strips CDATA and HTML from description", async () => {
    const items = await fetchRss("http://localhost:19970/rss");
    expect(items[1]!.description).toBe("Description with HTML");
  });

  test("parses Atom feed entries", async () => {
    const items = await fetchRss("http://localhost:19970/atom");
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe("Atom Entry");
    expect(items[0]!.link).toBe("https://example.com/atom1");
  });

  test("returns empty array for empty feed", async () => {
    const items = await fetchRss("http://localhost:19970/empty");
    expect(items).toHaveLength(0);
  });

  test("throws on 404", async () => {
    await expect(fetchRss("http://localhost:19970/notfound")).rejects.toThrow();
  });
});
