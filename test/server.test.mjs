import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CommunityArchiveClient, loadDotEnv } from "../dist/client.js";
import { buildServer } from "../dist/server.js";
import { resetMemberCache } from "../dist/extensions.js";

// ---- fixture archive ----
const T = (id, user, created_at, full_text, extra = {}) => ({
  tweet_id: id, account_id: user === "leo_guinan" ? "100" : "200", username: user,
  account_display_name: user === "leo_guinan" ? "Leo Guinan" : "Other Person",
  created_at, full_text, favorite_count: 0, retweet_count: 0, conversation_id: id, urls: [], media: [], ...extra,
});
const tweets = [
  T("1", "other", "2023-02-01T10:00:00.000Z", "movies not snapshots is a good frame", { favorite_count: 9 }),
  T("2", "leo_guinan", "2024-05-01T10:00:00.000Z", "We like movies, not snapshots. https://t.co/abc",
    { favorite_count: 40, urls: [{ url: "https://t.co/abc", expanded_url: "https://example.com/post" }] }),
  T("3", "leo_guinan", "2024-05-01T10:05:00.000Z", "2/ the movie is the receipt", { reply_to_tweet_id: "2", reply_to_username: "leo_guinan", conversation_id: "2" }),
  T("4", "leo_guinan", "2024-05-01T10:09:00.000Z", "3/ snapshots lie about time", { reply_to_tweet_id: "3", reply_to_username: "leo_guinan", conversation_id: "2" }),
  T("5", "other", "2025-01-01T10:00:00.000Z", "still thinking about movies not snapshots", { reply_to_tweet_id: "999", reply_to_username: "ghost", conversation_id: "999" }),
];
const membersList = [
  { account_id: "100", username: "leo_guinan", account_display_name: "Leo Guinan" },
  { account_id: "200", username: "other", account_display_name: "Ötto Person" },
  { account_id: "300", username: "exgenesis", account_display_name: "Xiq" },
];

function fakeApi({ rateLimitOnce = false } = {}) {
  let limited = !rateLimitOnce;
  const calls = [];
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    assert.equal(init.headers.Authorization, "Bearer cak_test");
    if (!limited) { limited = true; return json(429, { error: { code: "rate_limited", message: "slow down" } }, { "Retry-After": "1" }); }
    const p = u.pathname.replace(/^\/v1/, "");
    const q = Object.fromEntries(u.searchParams);
    let m;
    if (p === "/me") return json(200, { data: { key: "cak_…", limits: { per_minute: 60 } }, request_id: "r-me" });
    if ((m = p.match(/^\/tweets\/(\d+)$/))) {
      const t = tweets.find((x) => x.tweet_id === m[1]);
      return t ? json(200, { data: t, request_id: "r-" + m[1] }) : json(404, { error: { code: "not_found", message: "no such tweet" }, request_id: "r-404" });
    }
    if (p === "/tweets" && q.ids) return json(200, { data: q.ids.split(",").map((i) => tweets.find((t) => t.tweet_id === i)).filter(Boolean), next_cursor: null });
    if (p === "/tweets/search") {
      const needle = q.q.replace(/"/g, "").toLowerCase().split(/\s+/);
      let r = tweets.filter((t) => needle.every((w) => t.full_text.toLowerCase().includes(w)));
      if (q.from_user) r = r.filter((t) => t.username === q.from_user);
      r = r.sort((a, b) => b.created_at.localeCompare(a.created_at)); // newest first, like a real search
      const off = +(q.offset ?? 0), lim = +(q.limit ?? 25);
      const pg = r.slice(off, off + lim);
      return json(200, { data: pg, next_offset: off + lim < r.length ? off + lim : null, request_id: "r-s" });
    }
    if ((m = p.match(/^\/accounts\/([^/]+)\/tweets$/))) {
      let r = tweets.filter((t) => t.username === m[1] || t.account_id === m[1]);
      if (q.since) r = r.filter((t) => t.created_at >= q.since);
      if (q.until) r = r.filter((t) => t.created_at < q.until);
      r.sort((a, b) => (q.order === "asc" ? 1 : -1) * a.created_at.localeCompare(b.created_at));
      // two-item pages to exercise cursors
      const start = +(q.cursor ?? 0), lim = Math.min(2, +(q.limit ?? 50));
      return json(200, { data: r.slice(start, start + lim), next_cursor: start + lim < r.length ? String(start + lim) : null });
    }
    if (p === "/members") {
      const start = +(q.cursor ?? 0);
      return json(200, { data: membersList.slice(start, start + 2), next_cursor: start + 2 < membersList.length ? String(start + 2) : null });
    }
    if ((m = p.match(/^\/accounts\/([^/]+)\/(followers|following)$/))) {
      const f = { leo_guinan: ["a", "b", "c"], exgenesis: ["b", "c", "d", "e"] }[m[1]] ?? [];
      return json(200, { data: f.map((x) => ({ account_id: x, username: "u_" + x })), next_cursor: null });
    }
    if ((m = p.match(/^\/accounts\/([^/]+)$/))) {
      const a = membersList.find((x) => x.username === m[1]) ?? (m[1] === "notamember" ? { account_id: "900", username: "notamember" } : null);
      return a ? json(200, { data: a }) : json(404, { error: { code: "not_found", message: "no account" } });
    }
    return json(400, { error: { code: "bad_route", message: p } });
  };
  return { fetchImpl, calls };
}

async function connect(opts) {
  resetMemberCache();
  const api = fakeApi(opts);
  const client = new CommunityArchiveClient({ apiKey: "cak_test", fetchImpl: api.fetchImpl, sleep: async () => {} });
  const server = buildServer(client);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  const call = async (name, args = {}) => {
    const r = await mcp.callTool({ name, arguments: args });
    const text = r.content[0].text;
    return { isError: !!r.isError, text, json: r.isError ? null : JSON.parse(text) };
  };
  return { mcp, call, api, client };
}

test("lists all tools as read-only", async () => {
  const { mcp } = await connect();
  const { tools } = await mcp.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "ca_account", "ca_account_relations", "ca_account_tweets", "ca_find_people", "ca_first_said", "ca_get_tweets",
    "ca_me", "ca_members", "ca_phrase_timeline", "ca_receipt", "ca_relation_overlap", "ca_search_tweets",
    "ca_thread", "ca_tweets_window", "ca_who_talks_about",
  ]);
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint));
});

test("retries after 429 with Retry-After", async () => {
  const { call, api } = await connect({ rateLimitOnce: true });
  const r = await call("ca_me");
  assert.equal(r.isError, false);
  assert.equal(api.calls.length, 2);
});

test("get tweets by URL, reports missing, expands t.co", async () => {
  const { call } = await connect();
  const r = await call("ca_get_tweets", { refs: ["https://x.com/leo_guinan/status/2", "12345"] });
  assert.equal(r.json.tweets.length, 1);
  assert.deepEqual(r.json.missing, ["12345"]);
  assert.equal(r.json.tweets[0].text, "We like movies, not snapshots. https://example.com/post");
  assert.equal(r.json.tweets[0].url, "https://x.com/leo_guinan/status/2");
});

test("receipt hash matches the Receipt Cuts formula", async () => {
  const { call } = await connect();
  const r = await call("ca_receipt", { refs: ["2", "404404"] });
  const [ok, bad] = r.json.receipts;
  const expect = createHash("sha256").update(["tweet", "2024-05-01", "https://x.com/leo_guinan/status/2", ok.quote].join("|")).digest("hex");
  assert.equal(ok.sha256, expect);
  assert.equal(ok.date, "2024-05-01");
  assert.equal(ok.handle, "@leo_guinan");
  assert.equal(ok.provenance.request_id, "r-2");
  assert.match(bad.error, /not in the archive/i);
});

test("thread walks up and collects the author's continuation", async () => {
  const { call } = await connect();
  const r = await call("ca_thread", { ref: "3" });
  assert.deepEqual(r.json.tweets.map((t) => t.id), ["2", "3", "4"]);
  const orphan = await call("ca_thread", { ref: "5" });
  assert.match(orphan.json.notes[0], /999 by @ghost is not in the archive/);
});

test("first said scans all pages and sorts oldest first", async () => {
  const { call } = await connect();
  const r = await call("ca_first_said", { q: "movies snapshots", n: 2, scan: 50 });
  assert.equal(r.json.complete, true);
  assert.deepEqual(r.json.earliest.map((t) => t.id), ["1", "2"]);
  const mine = await call("ca_first_said", { q: "movies snapshots", from_user: "@leo_guinan" });
  assert.deepEqual(mine.json.earliest.map((t) => t.id), ["2"]);
});

test("phrase timeline buckets by year and ranks authors", async () => {
  const { call } = await connect();
  const r = await call("ca_phrase_timeline", { q: "snapshots", bucket: "year" });
  assert.deepEqual(r.json.series, [{ period: "2023", count: 1 }, { period: "2024", count: 2 }, { period: "2025", count: 1 }]);
  assert.deepEqual(r.json.top_authors.map((a) => a.count), [2, 2]);
  assert.equal(r.json.first.id, "1");
});

test("who talks about ranks people with their best tweet", async () => {
  const { call } = await connect();
  const r = await call("ca_who_talks_about", { q: "snapshots" });
  assert.equal(r.json.people[0].user, "leo_guinan");
  assert.equal(r.json.people[0].best.id, "2");
});

test("find people is fuzzy, accent-insensitive, and falls back to direct lookup", async () => {
  const { call } = await connect();
  assert.equal((await call("ca_find_people", { query: "leo" })).json.matches[0].username, "leo_guinan");
  assert.equal((await call("ca_find_people", { query: "otto" })).json.matches[0].username, "other");
  const d = await call("ca_find_people", { query: "@notamember" });
  assert.equal(d.json.matches.length, 0);
  assert.equal(d.json.direct_account.account_id, "900");
});

test("account timeline follows cursors across pages", async () => {
  const { call } = await connect();
  const r = await call("ca_account_tweets", { account: "https://x.com/leo_guinan", order: "asc", max_pages: 5 });
  assert.deepEqual(r.json.tweets.map((t) => t.id), ["2", "3", "4"]);
  assert.equal(r.json.next_cursor, null);
});

test("relation overlap computes shared accounts and Jaccard", async () => {
  const { call } = await connect();
  const r = await call("ca_relation_overlap", { a: "leo_guinan", b: "exgenesis", kind: "following" });
  assert.equal(r.json.shared_count, 2);
  assert.equal(r.json.jaccard, 0.4);
});

test("API errors come back as tool errors with hints", async () => {
  const { call } = await connect();
  const r = await call("ca_account", { account: "nobody_here" });
  assert.equal(r.isError, true);
  assert.match(r.text, /Not in the archive/);
});

test("dotenv parsing handles quotes, export and comments", () => {
  const env = loadDotEnv('# c\nexport A="x y"\nB=\'z\'\nCOMMUNITY_ARCHIVE_API_KEY=cak_abc # note\n');
  assert.deepEqual(env, { A: "x y", B: "z", COMMUNITY_ARCHIVE_API_KEY: "cak_abc" });
});
