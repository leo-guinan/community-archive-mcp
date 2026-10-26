import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CommunityArchiveClient, CAError } from "./client.js";
import { Tweet, parseTweetRef, shape, toReceipt } from "./format.js";
import * as ext from "./extensions.js";

const RO = { readOnlyHint: true, openWorldHint: true } as const;

const account = z.string().min(1).describe("Username (e.g. exgenesis) or numeric account ID. Prefix a numeric username with @.");
const since = z.string().optional().describe("Start, inclusive. ISO 8601 date or datetime, e.g. 2024-01-01.");
const until = z.string().optional().describe("End, exclusive. ISO 8601 date or datetime.");
const format = z.enum(["compact", "full"]).optional().describe("compact (default) trims each tweet to id, url, user, date, text and counts; full returns every API field.");
const maxPages = z.number().int().min(1).max(10).optional().describe("Pages to follow in one call (default 1).");
const cursor = z.string().optional().describe("next_cursor from a previous call.");

function ok(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }] };
}
function fail(e: unknown) {
  const msg =
    e instanceof CAError
      ? `${e.message}${e.requestId ? ` (request_id ${e.requestId})` : ""}`
      : e instanceof Error
        ? e.message
        : String(e);
  return { isError: true, content: [{ type: "text" as const, text: msg }] };
}
function wrap<A>(fn: (a: A) => Promise<unknown>) {
  return async (a: A) => {
    try {
      return ok(await fn(a));
    } catch (e) {
      return fail(e);
    }
  };
}
function normAccount(a: string) {
  const s = a.trim().replace(/^https?:\/\/(x|twitter)\.com\//, "").split(/[/?]/)[0];
  return s.startsWith("@") && !/^@\d+$/.test(s) ? s.slice(1) : s;
}

export function buildServer(c: CommunityArchiveClient) {
  const s = new McpServer(
    { name: "community-archive", version: "0.2.0", title: "Community Archive" },
    {
      instructions:
        "Read-only access to the Community Archive, an open database of uploaded Twitter/X archives. " +
        "Use ca_search_tweets or ca_first_said to find tweets, ca_find_people to resolve a person from a partial name, " +
        "and ca_receipt to cite a tweet with its exact text, date, permalink and hash. Tweet IDs are strings. " +
        "Results only cover people who uploaded their archive; absence from the archive is not evidence that something was never said.",
    },
  );

  // ---------------- API v1, one tool per route family ----------------

  s.registerTool(
    "ca_me",
    { title: "Key and limits", description: "Show the calling API key's identity and rate limits.", inputSchema: {}, annotations: RO },
    wrap(async () => (await c.get("/me", {}, { cache: false })).data),
  );

  s.registerTool(
    "ca_get_tweets",
    {
      title: "Get tweets",
      description: "Fetch tweets by ID or x.com/twitter.com status URL (1–100), returned in request order. Missing IDs were deleted, opted out, or never archived.",
      inputSchema: { refs: z.array(z.string()).min(1).max(100).describe("Tweet IDs or status URLs."), format },
      annotations: RO,
    },
    wrap(async ({ refs, format }: { refs: string[]; format?: "compact" | "full" }) => {
      const ids = refs.map(parseTweetRef);
      const page = ids.length === 1 ? await c.get<Tweet>(`/tweets/${ids[0]}`) : await c.get<Tweet[]>("/tweets", { ids: ids.join(",") });
      const list = (Array.isArray(page.data) ? page.data : page.data ? [page.data] : []) as Tweet[];
      const found = new Set(list.map((t) => t.tweet_id));
      return { tweets: shape(list, format), missing: ids.filter((i) => !found.has(i)), request_id: page.request_id };
    }),
  );

  s.registerTool(
    "ca_search_tweets",
    {
      title: "Search tweets",
      description: "Full-text search across the archive. Filter by author, by who was replied to, and by date. Pages with offset (max 5,000).",
      inputSchema: {
        q: z.string().min(1).describe("Search terms. Use quotes for a phrase."),
        from_user: z.string().optional().describe("Only tweets by this username."),
        reply_to_user: z.string().optional().describe("Only replies to this username."),
        since,
        until,
        limit: z.number().int().min(1).max(100).optional().describe("Results per page (default 25)."),
        offset: z.number().int().min(0).max(5000).optional(),
        format,
      },
      annotations: RO,
    },
    wrap(async (a: any) => {
      const page = await c.get<Tweet[]>("/tweets/search", {
        q: a.q, from_user: a.from_user && normAccount(a.from_user), reply_to_user: a.reply_to_user && normAccount(a.reply_to_user),
        since: a.since, until: a.until, limit: a.limit ?? 25, offset: a.offset,
      });
      return { tweets: shape(page.data ?? [], a.format), next_offset: page.next_offset ?? null, request_id: page.request_id };
    }),
  );

  s.registerTool(
    "ca_account",
    {
      title: "Look up accounts",
      description: "Profile and membership flags for one account, or for up to 100 by usernames or IDs.",
      inputSchema: {
        account: account.optional(),
        usernames: z.array(z.string()).max(100).optional(),
        ids: z.array(z.string()).max(100).optional(),
      },
      annotations: RO,
    },
    wrap(async (a: { account?: string; usernames?: string[]; ids?: string[] }) => {
      if (a.account) return (await c.get(`/accounts/${normAccount(a.account)}`)).data;
      if (a.usernames?.length) return (await c.get("/accounts", { usernames: a.usernames.map(normAccount).join(",") })).data;
      if (a.ids?.length) return (await c.get("/accounts", { ids: a.ids.join(",") })).data;
      throw new Error("Give account, usernames, or ids.");
    }),
  );

  s.registerTool(
    "ca_account_tweets",
    {
      title: "Account timeline",
      description: "An account's tweets in time order, optionally within a date range and without replies or retweets. Cursor-paged, up to 200 per page.",
      inputSchema: {
        account,
        order: z.enum(["asc", "desc"]).optional().describe("desc (default) is newest first."),
        since,
        until,
        exclude_replies: z.boolean().optional(),
        exclude_retweets: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Per page (default 50)."),
        cursor,
        max_pages: maxPages,
        format,
      },
      annotations: RO,
    },
    wrap(async (a: any) => {
      const r = await c.paged<Tweet>(`/accounts/${normAccount(a.account)}/tweets`, {
        order: a.order ?? "desc", since: a.since, until: a.until, exclude_replies: a.exclude_replies, exclude_retweets: a.exclude_retweets,
        limit: a.limit ?? 50, cursor: a.cursor,
      }, a.max_pages ?? 1);
      return { tweets: shape(r.items, a.format), next_cursor: r.next_cursor, pages: r.pages };
    }),
  );

  s.registerTool(
    "ca_tweets_window",
    {
      title: "Everything in a window",
      description: "Every archived tweet created between since and until (window of at most 31 days), across all accounts. Cursor-paged.",
      inputSchema: { since: z.string(), until: z.string(), limit: z.number().int().min(1).max(200).optional(), cursor, max_pages: maxPages, format },
      annotations: RO,
    },
    wrap(async (a: any) => {
      const r = await c.paged<Tweet>("/tweets", { since: a.since, until: a.until, limit: a.limit ?? 100, cursor: a.cursor }, a.max_pages ?? 1);
      return { tweets: shape(r.items, a.format), next_cursor: r.next_cursor, pages: r.pages };
    }),
  );

  s.registerTool(
    "ca_account_relations",
    {
      title: "Likes and follows",
      description: "Archive-derived likes, followers, or following for an account. Cursor-paged, up to 500 per page.",
      inputSchema: {
        account,
        kind: z.enum(["likes", "followers", "following"]),
        limit: z.number().int().min(1).max(500).optional(),
        cursor,
        max_pages: maxPages,
      },
      annotations: RO,
    },
    wrap(async (a: any) => {
      const r = await c.paged(`/accounts/${normAccount(a.account)}/${a.kind}`, { limit: a.limit ?? 100, cursor: a.cursor }, a.max_pages ?? 1);
      return { items: r.items, next_cursor: r.next_cursor, pages: r.pages };
    }),
  );

  s.registerTool(
    "ca_members",
    {
      title: "Members",
      description: "Current Community Archive members (people who uploaded their archive). Cursor-paged, up to 1,000 per page.",
      inputSchema: { limit: z.number().int().min(1).max(1000).optional(), cursor, max_pages: maxPages },
      annotations: RO,
    },
    wrap(async (a: any) => {
      const r = await c.paged("/members", { limit: a.limit ?? 200, cursor: a.cursor }, a.max_pages ?? 1);
      return { members: r.items, next_cursor: r.next_cursor };
    }),
  );

  // ---------------- extensions ----------------

  s.registerTool(
    "ca_receipt",
    {
      title: "Receipt for a tweet",
      description:
        "Turn tweets into dated proof records: exact text with links expanded, timestamp, permalink, author, and a SHA-256 over kind|date|url|quote (the Receipt Cuts format), plus the API request_id as provenance.",
      inputSchema: { refs: z.array(z.string()).min(1).max(25).describe("Tweet IDs or status URLs.") },
      annotations: RO,
    },
    wrap(async ({ refs }: { refs: string[] }) => {
      const out: any[] = [];
      for (const r of refs) {
        try {
          out.push(await ext.receipt(c, r));
        } catch (e) {
          out.push({ ref: r, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return { receipts: out };
    }),
  );

  s.registerTool(
    "ca_thread",
    {
      title: "Thread",
      description: "Reconstruct the thread around a tweet: the reply chain above it, and the author's own continuation below it.",
      inputSchema: {
        ref: z.string().describe("Tweet ID or status URL."),
        days_forward: z.number().min(0.1).max(14).optional().describe("How far after the tweet to look for continuations (default 3)."),
        format,
      },
      annotations: RO,
    },
    wrap(async (a: any) => {
      const t = await ext.thread(c, a.ref, { daysForward: a.days_forward });
      return { ...t, tweets: shape(t.tweets, a.format) };
    }),
  );

  const searchShape = {
    q: z.string().min(1).describe("Word or phrase. Use quotes for an exact phrase."),
    from_user: z.string().optional(),
    reply_to_user: z.string().optional(),
    since,
    until,
  };
  const sp = (a: any): ext.SearchParams => ({
    q: a.q, from_user: a.from_user && normAccount(a.from_user), reply_to_user: a.reply_to_user && normAccount(a.reply_to_user), since: a.since, until: a.until,
  });

  s.registerTool(
    "ca_first_said",
    {
      title: "First said",
      description: "Find the earliest archived tweets containing a word or phrase, overall or by one person. Answers 'when did I first say X' and 'who said it first'.",
      inputSchema: { ...searchShape, n: z.number().int().min(1).max(25).optional(), scan: z.number().int().min(50).max(5000).optional().describe("Max results to scan (default 1,000).") },
      annotations: RO,
    },
    wrap(async (a: any) => ext.firstSaid(c, sp(a), { n: a.n, scan: a.scan })),
  );

  s.registerTool(
    "ca_phrase_timeline",
    {
      title: "Phrase timeline",
      description: "Count how often a word or phrase appears per day, week, month, or year, with first and latest use and top authors. Useful for tracing how an idea spread.",
      inputSchema: {
        ...searchShape,
        bucket: z.enum(["day", "week", "month", "year"]).optional(),
        scan: z.number().int().min(50).max(5000).optional().describe("Max results to scan (default 2,000)."),
      },
      annotations: RO,
    },
    wrap(async (a: any) => ext.phraseTimeline(c, sp(a), { bucket: a.bucket, scan: a.scan })),
  );

  s.registerTool(
    "ca_who_talks_about",
    {
      title: "Who talks about",
      description: "Find people by topic: authors who tweet about a word or phrase, ranked by how often, with their earliest mention and best-received tweet.",
      inputSchema: { ...searchShape, top: z.number().int().min(1).max(50).optional(), scan: z.number().int().min(50).max(5000).optional() },
      annotations: RO,
    },
    wrap(async (a: any) => ext.whoTalksAbout(c, sp(a), { top: a.top, scan: a.scan })),
  );

  s.registerTool(
    "ca_find_people",
    {
      title: "Find people",
      description: "Find archive members by partial name or handle (fuzzy, accent-insensitive). Falls back to a direct account lookup for exact handles of non-members.",
      inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(50).optional() },
      annotations: RO,
    },
    wrap(async (a: any) => ext.findPeople(c, a.query, a.limit)),
  );

  s.registerTool(
    "ca_relation_overlap",
    {
      title: "Follow overlap",
      description: "Compare two accounts' followers or following: shared accounts and Jaccard similarity, from archive-derived edges.",
      inputSchema: { a: account, b: account, kind: z.enum(["followers", "following"]), max_pages: z.number().int().min(1).max(40).optional() },
      annotations: RO,
    },
    wrap(async (a: any) => ext.relationOverlap(c, normAccount(a.a), normAccount(a.b), a.kind, a.max_pages)),
  );

  return s;
}

export { toReceipt };
