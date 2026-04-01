import { logger } from "../observability/logger";

/**
 * Extract article text from HTML page using Playwright + Readability.
 * Handles SSR, SPA, JS-rendered content.
 */
export async function extractHtml(url: string): Promise<string | null> {
  try {
    const { chromium } = await import("playwright");
    const { Readability } = await import("@mozilla/readability");
    const { parseHTML } = await import("linkedom");

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000); // SPA stabilization

    const html = await page.content();
    await browser.close();

    const { document } = parseHTML(html);
    const reader = new Readability(document);
    const article = reader.parse();

    if (!article?.textContent || article.textContent.length < 100) {
      return null;
    }

    return article.textContent.trim();
  } catch (err) {
    logger.debug({ url, error: (err as Error).message }, "HTML extraction failed");
    return null;
  }
}
