interface RedditPost {
  title: string;
  selftext: string;
  url: string;
  permalink: string;
  score: number;
  isSelfPost: boolean;
}

interface RedditOAuthToken {
  access_token: string;
  expires_at: number;
}

let cachedToken: RedditOAuthToken | null = null;

/** Get Reddit OAuth token (client_credentials flow) */
async function getRedditToken(clientId: string, clientSecret: string): Promise<string> {
  if (cachedToken && cachedToken.expires_at > Date.now()) {
    return cachedToken.access_token;
  }

  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) throw new Error(`Reddit OAuth error ${res.status}`);

  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    access_token: json.access_token,
    expires_at: Date.now() + json.expires_in * 1000 - 60_000, // refresh 1min early
  };

  return cachedToken.access_token;
}

/** Fetch hot posts from a subreddit */
export async function fetchRedditHot(
  subreddit: string,
  clientId: string,
  clientSecret: string,
  limit = 25,
): Promise<RedditPost[]> {
  const token = await getRedditToken(clientId, clientSecret);

  const res = await fetch(
    `https://oauth.reddit.com/r/${subreddit}/hot.json?limit=${limit}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "knoldr/0.2.0",
      },
    },
  );

  if (!res.ok) throw new Error(`Reddit API error ${res.status}`);

  const json = (await res.json()) as {
    data: {
      children: Array<{
        data: {
          title: string;
          selftext: string;
          url: string;
          permalink: string;
          score: number;
          is_self: boolean;
        };
      }>;
    };
  };

  return json.data.children
    .map((c) => ({
      title: c.data.title,
      selftext: c.data.selftext,
      url: c.data.url,
      permalink: c.data.permalink,
      score: c.data.score,
      isSelfPost: c.data.is_self,
    }))
    .filter((p) => p.score >= 100);
}

export function redditToRaw(post: RedditPost): {
  raw: string;
  sources: Array<{ url: string; sourceType: string }>;
} {
  const content = post.isSelfPost ? post.selftext : "";
  return {
    raw: content ? `${post.title}\n\n${content}` : post.title,
    sources: [
      {
        url: `https://reddit.com${post.permalink}`,
        sourceType: "community_forum",
      },
    ],
  };
}
