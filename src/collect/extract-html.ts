import { logger } from "../observability/logger";
import type { Page } from "playwright";

export interface HtmlExtraction {
  text: string | null;
  links: string[];
}

/**
 * Extract article text + links from an already-loaded Playwright page.
 * The caller manages the browser/page lifecycle.
 */
export async function extractFromPage(page: Page): Promise<HtmlExtraction> {
  try {
    const { Readability } = await import("@mozilla/readability");
    const { parseHTML } = await import("linkedom");

    const html = await page.content();

    // Extract links before Readability mutates
    const links = await page.evaluate(`
      Array.from(document.querySelectorAll("a[href]"))
        .map(a => a.href)
        .filter(href => href.startsWith("http"))
    `) as string[];

    // Extract article text
    const { document } = parseHTML(html);
    const reader = new Readability(document);
    const article = reader.parse();

    const text = article?.textContent?.trim() ?? null;

    return {
      text: text && text.length >= 100 ? text : null,
      links: [...new Set(links)],
    };
  } catch (err) {
    logger.debug({ error: (err as Error).message }, "HTML extraction failed");
    return { text: null, links: [] };
  }
}
