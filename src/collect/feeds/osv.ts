interface OsvVulnerability {
  id: string;
  summary: string;
  details: string;
  affected: string[];
  url: string;
}

/** Query OSV.dev for vulnerabilities by ecosystem */
export async function fetchOsvVulnerabilities(ecosystem: string): Promise<OsvVulnerability[]> {
  const res = await fetch("https://api.osv.dev/v1/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ package: { ecosystem } }),
  });

  if (!res.ok) return [];

  const json = (await res.json()) as {
    vulns?: Array<{
      id: string;
      summary?: string;
      details?: string;
      affected?: Array<{ package?: { name?: string } }>;
    }>;
  };

  return (json.vulns ?? []).map((v) => ({
    id: v.id,
    summary: v.summary ?? "",
    details: v.details ?? "",
    affected: v.affected?.map((a) => a.package?.name ?? "").filter(Boolean) ?? [],
    url: `https://osv.dev/vulnerability/${v.id}`,
  }));
}

export function osvToRaw(vuln: OsvVulnerability): {
  raw: string;
  sources: Array<{ url: string; sourceType: string }>;
} {
  return {
    raw: `${vuln.id}: ${vuln.summary}\n\n${vuln.details}\n\nAffected: ${vuln.affected.join(", ")}`,
    sources: [{ url: vuln.url, sourceType: "cve_db" }],
  };
}
