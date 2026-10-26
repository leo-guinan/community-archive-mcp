import { createHash } from "node:crypto";

export type Tweet = {
  tweet_id: string;
  account_id?: string;
  username?: string;
  account_display_name?: string;
  avatar_media_url?: string;
  created_at: string;
  full_text: string;
  favorite_count?: number;
  retweet_count?: number;
  reply_to_tweet_id?: string | null;
  reply_to_user_id?: string | null;
  reply_to_username?: string | null;
  quoted_tweet_id?: string | null;
  retweeted_tweet_id?: string | null;
  conversation_id?: string | null;
  media?: any[];
  urls?: any[];
  mentioned_account_ids?: string[];
  [k: string]: any;
};

export function permalink(t: Pick<Tweet, "tweet_id" | "username">): string {
  return t.username ? `https://x.com/${t.username}/status/${t.tweet_id}` : `https://x.com/i/status/${t.tweet_id}`;
}

/** Accepts a numeric ID or an x.com / twitter.com status URL. */
export function parseTweetRef(ref: string): string {
  const s = String(ref).trim();
  if (/^\d{1,25}$/.test(s)) return s;
  const m = s.match(/status(?:es)?\/(\d{1,25})/);
  if (m) return m[1];
  throw new Error(`"${ref}" is not a tweet ID or a status URL.`);
}

/** Replace t.co links with their expanded form when the urls[] entry provides one. */
export function expandText(t: Tweet): string {
  let text = t.full_text ?? "";
  for (const u of t.urls ?? []) {
    if (!u || typeof u !== "object") continue;
    const short = u.url ?? u.short_url;
    const long = u.expanded_url ?? u.expanded ?? u.display_url;
    if (short && long && typeof short === "string") text = text.split(short).join(long);
  }
  // Media t.co links add nothing in a quote.
  for (const m of t.media ?? []) {
    const short = m?.url ?? m?.short_url;
    if (short && typeof short === "string") text = text.split(short).join("").trim();
  }
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

export function compactTweet(t: Tweet) {
  const out: Record<string, any> = {
    id: t.tweet_id,
    url: permalink(t),
    user: t.username,
    name: t.account_display_name,
    created_at: t.created_at,
    text: expandText(t),
    likes: t.favorite_count ?? 0,
    retweets: t.retweet_count ?? 0,
  };
  if (t.reply_to_tweet_id) out.reply_to = { id: t.reply_to_tweet_id, user: t.reply_to_username ?? undefined };
  if (t.quoted_tweet_id) out.quoted_id = t.quoted_tweet_id;
  if (t.retweeted_tweet_id) out.retweet_of = t.retweeted_tweet_id;
  if (t.conversation_id && t.conversation_id !== t.tweet_id) out.conversation_id = t.conversation_id;
  if (t.media?.length) out.media = t.media.length;
  return out;
}

export function shape(tweets: Tweet[], format: "compact" | "full" | undefined) {
  return format === "full" ? tweets : tweets.map(compactTweet);
}

/**
 * A source record in the shape Receipt Cuts uses, plus provenance.
 * sha256 is computed over kind|date|url|quote, the same fields and order Receipt Cuts hashes,
 * so the hash printed on a receipt can be re-derived from the archive.
 */
export function toReceipt(t: Tweet, meta: { request_id?: string; fetched_at?: string } = {}) {
  const quote = expandText(t);
  const date = t.created_at.slice(0, 10);
  const url = permalink(t);
  const kind = "tweet";
  const sha256 = createHash("sha256").update([kind, date, url, quote].join("|")).digest("hex");
  return {
    kind,
    date,
    created_at: t.created_at,
    title: t.reply_to_username ? `Reply to @${t.reply_to_username}` : "Post",
    author: t.account_display_name ?? t.username ?? "",
    handle: t.username ? `@${t.username}` : "",
    quote,
    url,
    sha256,
    tweet_id: t.tweet_id,
    likes: t.favorite_count ?? 0,
    retweets: t.retweet_count ?? 0,
    provenance: {
      source: "Community Archive API v1",
      request_id: meta.request_id ?? null,
      fetched_at: meta.fetched_at ?? new Date().toISOString(),
    },
  };
}

export function bucketKey(iso: string, bucket: "day" | "week" | "month" | "year"): string {
  if (bucket === "year") return iso.slice(0, 4);
  if (bucket === "month") return iso.slice(0, 7);
  if (bucket === "day") return iso.slice(0, 10);
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7; // Monday start
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}
