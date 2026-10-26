// A tiny stand-in for https://analytics.community-archive.org/v1, for end-to-end tests.
import http from "node:http";

export const GOOD_KEY = "cak_good_test_key_0123456789abcdef";

const T = (id, user, created_at, full_text, extra = {}) => ({
  tweet_id: id, account_id: user === "leo_guinan" ? "100" : "200", username: user,
  account_display_name: user === "leo_guinan" ? "Leo Guinan" : "Other Person",
  created_at, full_text, favorite_count: 0, retweet_count: 0, conversation_id: id, urls: [], media: [], ...extra,
});
const tweets = [
  T("1", "other", "2023-02-01T10:00:00.000Z", "movies not snapshots is a good frame", { favorite_count: 9 }),
  T("2", "leo_guinan", "2024-05-01T10:00:00.000Z", "We like movies, not snapshots.", { favorite_count: 40 }),
];

export function startMockApi(port) {
  const seen = { auth: [], paths: [] };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    seen.auth.push(req.headers.authorization ?? "");
    seen.paths.push(u.pathname);
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${GOOD_KEY}`) return send(401, { error: { code: "unauthorized", message: "Invalid API key" } });
    const p = u.pathname.replace(/^\/v1/, "");
    let m;
    if (p === "/me") return send(200, { data: { key_name: "test", limits: { per_minute: 60, per_day: 20000 } }, request_id: "r-me" });
    if ((m = p.match(/^\/tweets\/(\d+)$/))) {
      const t = tweets.find((x) => x.tweet_id === m[1]);
      return t ? send(200, { data: t, request_id: "r-" + m[1] }) : send(404, { error: { code: "not_found", message: "no such tweet" } });
    }
    if (p === "/tweets/search") {
      const words = (u.searchParams.get("q") ?? "").toLowerCase().split(/\s+/);
      const r = tweets.filter((t) => words.every((w) => t.full_text.toLowerCase().includes(w)));
      return send(200, { data: r, next_offset: null, request_id: "r-s" });
    }
    return send(404, { error: { code: "not_found", message: p } });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, seen })));
}
