import { fetchRss } from "./rss";

interface GithubRelease {
  repo: string;
  tag: string;
  body: string;
  url: string;
}

/** Fetch GitHub releases via Atom feed */
export async function fetchGithubReleases(repoUrl: string): Promise<GithubRelease[]> {
  // repoUrl: https://github.com/oven-sh/bun
  // Atom feed: https://github.com/oven-sh/bun/releases.atom
  const atomUrl = repoUrl.replace(/\/$/, "") + "/releases.atom";
  const items = await fetchRss(atomUrl);

  const repoName = repoUrl.replace(/^https?:\/\/github\.com\//, "").replace(/\/$/, "");

  return items.map((item) => ({
    repo: repoName,
    tag: item.title,
    body: item.description,
    url: item.link,
  }));
}

export function githubReleaseToRaw(release: GithubRelease): {
  raw: string;
  sources: Array<{ url: string; sourceType: string }>;
} {
  return {
    raw: `${release.repo} ${release.tag}\n\n${release.body}`,
    sources: [{ url: release.url, sourceType: "github_release" }],
  };
}
