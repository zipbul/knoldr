import { createHash } from "crypto";

/** Remove tracking parameters from URL */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const trackingParams = [
      "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
      "ref", "source", "fbclid", "gclid", "mc_cid", "mc_eid",
    ];
    for (const param of trackingParams) {
      parsed.searchParams.delete(param);
    }
    // Remove trailing slash
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString();
  } catch {
    return url;
  }
}

/** SHA-256 hash of normalized URL for dedup */
export function hashUrl(url: string): string {
  return createHash("sha256").update(normalizeUrl(url)).digest("hex");
}
