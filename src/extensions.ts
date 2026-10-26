// Features built on top of API v1 that the API does not offer directly.
import { CommunityArchiveClient, CAError } from "./client.js";
import { Tweet, bucketKey, compactTweet, parseTweetRef, toReceipt } from "./format.js";

export const SEARCH_PAGE = 100;
export const SEARCH_MAX_OFFSET = 5000;

export interface SearchParams {
  q: string;
  from_user?: string;
  reply_to_user?: string;
  since?: string;
  until?: string;
}

/** Page through /tweets/search up to `scan` results. */
export async function scanSearch(c: CommunityArchiveClient, p: SearchParams, scan: number) {
  const tweets: Tweet[] = [];
  const request_ids: string[] = [];
  let offset = 0;
  let exhausted = false;
  while (tweets.length < scan) {
    const limit = Math.min(SEARCH_PAGE, scan - tweets.length);
    const page = await c.get<Tweet[]>("/tweets/search", { ...p, limit, offset });
    if (page.request_id) request_ids.push(page.request_id);
    const data = Array.isArray(page.data) ? page.data : [];
    tweets.push(...data);
    const next = page.next_offset;
    if (next === null || next === undefined || next > SEARCH_MAX_OFFSET) {
      exhausted = next === null || next === undefined;
      break;
    }
    offset = next;
  }
  // dedupe
  const seen = new Set<string>();
  const unique = tweets.filter((t) => (seen.has(t.tweet_id) ? false : (seen.add(t.tweet_id), true)));
  return { tweets: unique, exhausted, request_ids };
}

export async function getTweet(c: CommunityArchiveClient, ref: string) {
  const id = parseTweetRef(ref);
  const page = await c.get<Tweet>(`/tweets/${id}`);
  if (!page.data) throw new CAError("not_found", `Tweet ${id} is not in the archive.`, 404, page.request_id);
  return { tweet: page.data, request_id: page.request_id };
}

export async function receipt(c: CommunityArchiveClient, ref: string) {
  const { tweet, request_id } = await getTweet(c, ref);
  return toReceipt(tweet, { request_id, fetched_at: new Date().toISOString() });
}

/** Walk reply_to upward, then collect the author's own continuation of the thread. */
export async function thread(c: CommunityArchiveClient, ref: string, opts: { maxAncestors?: number; daysForward?: number } = {}) {
  const maxAncestors = opts.maxAncestors ?? 25;
  const daysForward = opts.daysForward ?? 3;
  const { tweet: focus } = await getTweet(c, ref);
  const notes: string[] = [];

  const ancestors: Tweet[] = [];
  let cur = focus;
  while (cur.reply_to_tweet_id && ancestors.length < maxAncestors) {
    try {
      const page = await c.get<Tweet>(`/tweets/${cur.reply_to_tweet_id}`);
      if (!page.data) break;
      ancestors.unshift(page.data);
      cur = page.data;
    } catch (e) {
      if (e instanceof CAError && e.status === 404) {
        notes.push(`Parent ${cur.reply_to_tweet_id}${cur.reply_to_username ? ` by @${cur.reply_to_username}` : ""} is not in the archive.`);
        break;
      }
      throw e;
    }
  }
  const root = ancestors[0] ?? focus;

  // Self-thread continuation: same author, same conversation, replying within the chain.
  const descendants: Tweet[] = [];
  if (focus.username && focus.conversation_id) {
    const since = focus.created_at;
    const until = new Date(new Date(focus.created_at).getTime() + daysForward * 86_400_000).toISOString();
    const { items } = await c.paged<Tweet>(`/accounts/${focus.account_id ?? focus.username}/tweets`, { order: "asc", since, until, limit: 200 }, 5);
    const chain = new Set([focus.tweet_id]);
    for (const t of items.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
      if (t.tweet_id === focus.tweet_id) continue;
      if (t.conversation_id === focus.conversation_id && t.reply_to_tweet_id && chain.has(t.reply_to_tweet_id)) {
        descendants.push(t);
        chain.add(t.tweet_id);
      }
    }
  }
  return {
    root_id: root.tweet_id,
    focus_id: focus.tweet_id,
    tweets: [...ancestors, focus, ...descendants],
    counts: { ancestors: ancestors.length, continuation: descendants.length },
    notes,
  };
}

/** Earliest occurrences of a phrase among search results. */
export async function firstSaid(c: CommunityArchiveClient, p: SearchParams, opts: { scan?: number; n?: number } = {}) {
  const { tweets, exhausted } = await scanSearch(c, p, opts.scan ?? 1000);
  const sorted = [...tweets].sort((a, b) => a.created_at.localeCompare(b.created_at));
  return {
    query: p,
    scanned: tweets.length,
    complete: exhausted,
    caveat: exhausted
      ? null
      : "Search returned more results than were scanned. These are the earliest among the scanned results; add until= to look further back.",
    earliest: sorted.slice(0, opts.n ?? 5).map((t) => ({ ...compactTweet(t), receipt_sha256: toReceipt(t).sha256 })),
  };
}

/** How often a phrase appears over time, and who says it. */
export async function phraseTimeline(
  c: CommunityArchiveClient,
  p: SearchParams,
  opts: { scan?: number; bucket?: "day" | "week" | "month" | "year"; top?: number } = {},
) {
  const bucket = opts.bucket ?? "month";
  const { tweets, exhausted } = await scanSearch(c, p, opts.scan ?? 2000);
  const buckets = new Map<string, number>();
  const authors = new Map<string, { count: number; first: string; likes: number }>();
  for (const t of tweets) {
    const k = bucketKey(t.created_at, bucket);
    buckets.set(k, (buckets.get(k) ?? 0) + 1);
    const u = t.username ?? t.account_id ?? "?";
    const a = authors.get(u) ?? { count: 0, first: t.created_at, likes: 0 };
    a.count++;
    a.likes += t.favorite_count ?? 0;
    if (t.created_at < a.first) a.first = t.created_at;
    authors.set(u, a);
  }
  const sorted = [...tweets].sort((a, b) => a.created_at.localeCompare(b.created_at));
  return {
    query: p,
    scanned: tweets.length,
    complete: exhausted,
    bucket,
    series: [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, count]) => ({ period, count })),
    first: sorted[0] ? compactTweet(sorted[0]) : null,
    latest: sorted.at(-1) ? compactTweet(sorted.at(-1)!) : null,
    top_authors: [...authors.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, opts.top ?? 10)
      .map(([user, v]) => ({ user, ...v })),
  };
}

/** People who tweet about a topic, ranked by how often and how well it landed. */
export async function whoTalksAbout(c: CommunityArchiveClient, p: SearchParams, opts: { scan?: number; top?: number } = {}) {
  const { tweets, exhausted } = await scanSearch(c, p, opts.scan ?? 500);
  const by = new Map<string, { name?: string; count: number; likes: number; first: string; best?: Tweet }>();
  for (const t of tweets) {
    const u = t.username ?? t.account_id ?? "?";
    const e = by.get(u) ?? { name: t.account_display_name, count: 0, likes: 0, first: t.created_at };
    e.count++;
    e.likes += t.favorite_count ?? 0;
    if (t.created_at < e.first) e.first = t.created_at;
    if (!e.best || (t.favorite_count ?? 0) > (e.best.favorite_count ?? 0)) e.best = t;
    by.set(u, e);
  }
  return {
    query: p,
    scanned: tweets.length,
    complete: exhausted,
    people: [...by.entries()]
      .sort((a, b) => b[1].count - a[1].count || b[1].likes - a[1].likes)
      .slice(0, opts.top ?? 15)
      .map(([user, e]) => ({ user, name: e.name, tweets: e.count, total_likes: e.likes, first_mention: e.first, best: e.best ? compactTweet(e.best) : null })),
  };
}

// ---- people lookup over the member directory (cached) ----
let memberCache: { at: number; members: any[] } | null = null;
const MEMBER_TTL = 6 * 3600_000;

export function resetMemberCache() {
  memberCache = null;
}

async function members(c: CommunityArchiveClient) {
  if (memberCache && Date.now() - memberCache.at < MEMBER_TTL) return memberCache.members;
  const { items } = await c.paged("/members", { limit: 1000 }, 50);
  memberCache = { at: Date.now(), members: items };
  return items;
}

function fold(s: string) {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export async function findPeople(c: CommunityArchiveClient, query: string, limit = 10) {
  const q = fold(query.replace(/^@/, "").trim());
  if (!q) throw new Error("Give a name or handle to look for.");
  const all = await members(c);
  const scored: Array<{ score: number; m: any }> = [];
  for (const m of all) {
    const user = fold(String(m.username ?? ""));
    const name = fold(String(m.account_display_name ?? m.display_name ?? m.name ?? ""));
    let score = 0;
    if (user === q) score = 100;
    else if (user.startsWith(q)) score = 80;
    else if (name === q) score = 75;
    else if (user.includes(q)) score = 60;
    else if (name.includes(q)) score = 55;
    else {
      const parts = q.split(/\s+/).filter(Boolean);
      if (parts.length > 1 && parts.every((p) => name.includes(p) || user.includes(p))) score = 40;
    }
    if (score) scored.push({ score, m });
  }
  scored.sort((a, b) => b.score - a.score);
  const matches = scored.slice(0, limit).map(({ score, m }) => ({ match: score, ...m }));

  // Not every account in the archive is a current member; try a direct lookup for handle-like queries.
  let direct: any = null;
  if (!matches.some((x) => x.match === 100) && /^[A-Za-z0-9_]{1,15}$/.test(query.replace(/^@/, ""))) {
    try {
      const h = query.replace(/^@/, "");
      direct = (await c.get(`/accounts/${/^\d+$/.test(h) ? "@" + h : h}`)).data ?? null;
    } catch (e) {
      if (!(e instanceof CAError && e.status === 404)) throw e;
    }
  }
  return { query, members_searched: all.length, matches, direct_account: direct };
}

// ---- follow-graph overlap ----
function edgeKey(e: any, owner: string): string | null {
  if (typeof e === "string") return e;
  if (!e || typeof e !== "object") return null;
  for (const k of ["account_id", "follower_account_id", "following_account_id", "target_account_id", "username"]) {
    if (e[k] && String(e[k]) !== owner) return String(e[k]);
  }
  return null;
}

export async function relationOverlap(
  c: CommunityArchiveClient,
  a: string,
  b: string,
  kind: "followers" | "following",
  maxPages = 20,
) {
  const [pa, pb] = await Promise.all([
    c.paged(`/accounts/${a}/${kind}`, { limit: 500 }, maxPages),
    c.paged(`/accounts/${b}/${kind}`, { limit: 500 }, maxPages),
  ]);
  const ka = new Map<string, any>();
  for (const e of pa.items) {
    const k = edgeKey(e, a);
    if (k) ka.set(k, e);
  }
  const shared: any[] = [];
  const kb = new Set<string>();
  for (const e of pb.items) {
    const k = edgeKey(e, b);
    if (!k) continue;
    kb.add(k);
    if (ka.has(k)) shared.push(e);
  }
  return {
    kind,
    a: { account: a, count: ka.size, complete: pa.next_cursor === null },
    b: { account: b, count: kb.size, complete: pb.next_cursor === null },
    shared_count: shared.length,
    jaccard: ka.size + kb.size ? +(shared.length / (ka.size + kb.size - shared.length)).toFixed(4) : 0,
    shared: shared.slice(0, 200),
    edge_fields: pa.items[0] && typeof pa.items[0] === "object" ? Object.keys(pa.items[0]) : [],
  };
}
