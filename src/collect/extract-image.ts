import { logger } from "../observability/logger";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const GEMINI_CLI = process.env.KNOLDR_GEMINI_CLI ?? "gemini";
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const SUPPORTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/gif"]);

/**
 * Download image and extract text/description via Gemini CLI multimodal.
 */
export async function extractImage(url: string): Promise<string | null> {
  let tmpDir: string | null = null;

  try {
    // Download image
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (!SUPPORTED_TYPES.has(contentType)) {
      logger.debug({ url, contentType }, "unsupported image type");
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_IMAGE_SIZE) {
      logger.debug({ url, size: buffer.length }, "image too large");
      return null;
    }

    // Write to temp file
    tmpDir = await mkdtemp(join(tmpdir(), "knoldr-img-"));
    const ext = contentType.split("/")[1]?.replace("svg+xml", "svg") ?? "png";
    const imgPath = join(tmpDir, `image.${ext}`);
    await writeFile(imgPath, buffer);

    // Call Gemini CLI with image
    const cliParts = GEMINI_CLI.split(/\s+/);
    const prompt = `Extract all text, data, labels, and descriptions from this image. If it's a diagram, describe the structure. If it's a screenshot, extract all visible text. If it's a chart/table, extract the data. Return plain text only.`;

    const proc = Bun.spawn([...cliParts, "-p", prompt, "--file", imgPath], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      logger.debug({ url, exitCode }, "Gemini CLI image extraction failed");
      return null;
    }

    // Parse response — may be JSON string or object with text field
    let text: string;
    try {
      const json = JSON.parse(stdout);
      text = typeof json === "string" ? json : (json.text ?? json.content ?? stdout);
    } catch {
      text = stdout;
    }

    text = String(text).trim();
    return text.length >= 50 ? text : null;
  } catch (err) {
    logger.debug({ url, error: (err as Error).message }, "image extraction failed");
    return null;
  } finally {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
