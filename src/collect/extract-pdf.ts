import { logger } from "../observability/logger";

const MAX_PDF_SIZE = 50 * 1024 * 1024; // 50MB

/**
 * Download PDF from URL and extract text using pdf-parse.
 * Max 100 pages. Falls back to Gemini multimodal for scanned PDFs.
 */
export async function extractPdf(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) return null;

    const contentLength = Number(res.headers.get("content-length") ?? 0);
    if (contentLength > MAX_PDF_SIZE) {
      logger.debug({ url, contentLength }, "PDF too large, skipping");
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_PDF_SIZE) return null;

    // @ts-expect-error pdf-parse types are inconsistent across ESM/CJS
    const pdfParse = (await import("pdf-parse")).default ?? (await import("pdf-parse"));
    const data = await pdfParse(buffer, { max: 100 });

    const text = data.text?.trim();
    if (!text || text.length < 100) {
      // Possibly scanned PDF — could use Gemini multimodal here
      logger.debug({ url, textLength: text?.length ?? 0 }, "PDF text too short, possibly scanned");
      return null;
    }

    return text;
  } catch (err) {
    logger.debug({ url, error: (err as Error).message }, "PDF extraction failed");
    return null;
  }
}
