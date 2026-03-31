interface NpmPackageInfo {
  name: string;
  version: string;
  description: string;
  url: string;
}

/** Fetch package info from npm registry */
export async function fetchNpmPackage(packageName: string): Promise<NpmPackageInfo | null> {
  const res = await fetch(`https://registry.npmjs.org/${packageName}`);
  if (!res.ok) return null;

  const json = (await res.json()) as {
    name: string;
    "dist-tags": { latest: string };
    description?: string;
  };

  const version = json["dist-tags"].latest;
  return {
    name: json.name,
    version,
    description: json.description ?? "",
    url: `https://www.npmjs.com/package/${json.name}`,
  };
}

export function npmToRaw(pkg: NpmPackageInfo): {
  raw: string;
  sources: Array<{ url: string; sourceType: string }>;
} {
  return {
    raw: `${pkg.name}@${pkg.version}\n\n${pkg.description}`,
    sources: [{ url: pkg.url, sourceType: "official_docs" }],
  };
}
