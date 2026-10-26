// Server-rendered pages: the sign-in (key) page, the landing page, and the privacy policy.
// Everything that came from a client (name, domain, redirect host, scopes) is escaped.

export const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"'`]/g, (c) => `&#${c.charCodeAt(0)};`);

const CSS = `
:root{--bg:#f4f5f2;--card:#ffffff;--fg:#1d211f;--muted:#5c645f;--line:#d9ddd8;--accent:#1f5e52;--accent-fg:#fff;--warn-bg:#fff4dc;--warn-fg:#6b4a00;--err-bg:#fde8e6;--err-fg:#8a1c12;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#121513;--card:#1b1f1d;--fg:#e8ebe9;--muted:#a0a8a3;--line:#2e3431;--accent:#5fb8a4;--accent-fg:#0b1512;--warn-bg:#3a2e12;--warn-fg:#f3d58f;--err-bg:#3d1a17;--err-fg:#f5b3ab;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:640px;margin:0 auto;padding:40px max(16px,env(safe-area-inset-left)) 64px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px}
h1{font-size:24px;line-height:1.25;margin:0 0 8px;text-wrap:balance}
h2{font-size:17px;margin:28px 0 8px}
p{margin:0 0 14px}
.muted{color:var(--muted)}
.eyebrow{font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:14px}
.facts{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:18px 0;padding:14px 16px;border:1px solid var(--line);border-radius:8px;font-size:15px}
.facts dt{color:var(--muted)}.facts dd{margin:0;overflow-wrap:anywhere}
label{display:block;font-weight:600;margin:18px 0 6px}
input[type=password]{width:100%;font:15px ui-monospace,SFMono-Regular,Menlo,monospace;padding:11px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
input:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:20px}
button{font:600 15px/1 inherit;font-family:inherit;padding:12px 18px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
.note{font-size:14px;color:var(--muted);margin-top:18px}
.warn{background:var(--warn-bg);color:var(--warn-fg);padding:12px 14px;border-radius:8px;font-size:14px;margin:12px 0}
.err{background:var(--err-bg);color:var(--err-fg);padding:12px 14px;border-radius:8px;font-size:14px;margin:12px 0}
code,pre{font:14px ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px;overflow-x:auto;white-space:pre}
ul{padding-left:20px}li{margin:4px 0}
a{color:var(--accent)}
table{border-collapse:collapse;width:100%;font-size:14px}td{border-top:1px solid var(--line);padding:8px 8px 8px 0;vertical-align:top}td:first-child{white-space:nowrap}
.tablewrap{overflow-x:auto}
`;

export const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><main>${body}</main></body></html>`;
}

export function html(body: string, status = 200, extra?: Headers): Response {
  const h = extra ?? new Headers();
  h.set("Content-Type", "text/html; charset=utf-8");
  h.set("Content-Security-Policy", PAGE_CSP);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  if (!h.has("Cache-Control")) h.set("Cache-Control", "no-store");
  return new Response(body, { status, headers: h });
}

export interface ConsentFacts {
  clientName: string;
  clientDomain?: string;
  redirectHost: string;
  redirectIsLoopback: boolean;
  scope: string[];
}

export function authorizePage(o: { facts: ConsentFacts; handle: string; query: string; error?: string }): string {
  const f = o.facts;
  const who = f.clientDomain
    ? `<dd><strong>${esc(f.clientName)}</strong>, published by <strong>${esc(f.clientDomain)}</strong></dd>`
    : `<dd><strong>${esc(f.clientName)}</strong> <span class="muted">(name not verified)</span></dd>`;
  return layout(
    "Connect the Community Archive",
    `<div class="card">
<div class="eyebrow">Community Archive connector</div>
<h1>Connect your Community Archive key</h1>
<p class="muted">This lets the app below search and read the Community Archive on your behalf, using your own API key. Access is read-only.</p>
<dl class="facts">
<dt>App</dt>${who}
<dt>Sends access to</dt><dd><strong>${esc(f.redirectHost)}</strong></dd>
<dt>Access</dt><dd>${f.scope.length ? f.scope.map(esc).join(", ") : "archive:read"} (read tweets, accounts and members)</dd>
</dl>
${f.redirectIsLoopback ? `<div class="warn">This sends access to an app on your own computer. Continue only if you just started connecting from it.</div>` : ""}
${o.error ? `<div class="err" role="alert">${esc(o.error)}</div>` : ""}
<form method="post" action="/authorize" autocomplete="off">
<input type="hidden" name="handle" value="${esc(o.handle)}">
<input type="hidden" name="q" value="${esc(o.query)}">
<label for="api_key">Your API key</label>
<input id="api_key" name="api_key" type="password" placeholder="cak_…" spellcheck="false" autocapitalize="off" autocomplete="off" required>
<p class="note">Don't have one? <a href="https://www.community-archive.org/settings/api-keys" target="_blank" rel="noopener noreferrer">Create a key on community-archive.org</a>, then paste it here.</p>
<div class="row">
<button class="primary" type="submit" name="decision" value="approve">Connect</button>
<button type="submit" name="decision" value="deny" formnovalidate>Cancel</button>
</div>
</form>
<p class="note">We check the key with the Community Archive, then keep it encrypted with this connection only. It is never shown again or written to logs. Disconnect the connector or delete the key on community-archive.org to end access. <a href="/privacy">Privacy</a></p>
</div>`,
  );
}

export function errorPage(title: string, message: string): string {
  return layout(
    title,
    `<div class="card"><div class="eyebrow">Community Archive connector</div><h1>${esc(title)}</h1><p>${esc(message)}</p>
<p class="muted">Start connecting again from the app you were using.</p></div>`,
  );
}

const TOOLS: Array<[string, string]> = [
  ["ca_search_tweets", "Full-text search with author, reply-to and date filters"],
  ["ca_get_tweets", "Tweets by ID or pasted x.com link"],
  ["ca_account / ca_account_tweets", "Profiles and timelines"],
  ["ca_tweets_window", "Everything posted in a window of up to 31 days"],
  ["ca_account_relations", "Likes, followers and following from uploaded archives"],
  ["ca_members", "People who have uploaded their archive"],
  ["ca_receipt", "Dated proof record of a tweet: exact text, time, permalink and a SHA-256"],
  ["ca_thread", "Rebuild the thread around a tweet"],
  ["ca_first_said", "Earliest uses of a phrase, overall or by one person"],
  ["ca_phrase_timeline", "How often a phrase appears over time, and who says it"],
  ["ca_who_talks_about", "People who tweet about a topic"],
  ["ca_find_people", "People by partial name or handle"],
  ["ca_relation_overlap", "Shared followers or following between two accounts"],
  ["ca_me", "Your key's limits"],
];

export function landingPage(origin: string, repoUrl?: string): string {
  const mcp = `${origin}/mcp`;
  return layout(
    "Community Archive connector",
    `<div class="eyebrow">Remote MCP server</div>
<h1>Community Archive connector</h1>
<p>Search and cite the <a href="https://www.community-archive.org">Community Archive</a>, the open database of uploaded Twitter/X archives, from Claude and other MCP clients. You connect with your own Community Archive API key. Access is read-only.</p>
<h2>Server URL</h2>
<pre>${esc(mcp)}</pre>
<h2>Add it to Claude</h2>
<ul>
<li>Go to <strong>Customize → Connectors</strong>, choose <strong>Add custom connector</strong>, and paste the URL above. On Team and Enterprise plans an Owner adds it under <strong>Organization settings → Connectors</strong>.</li>
<li>Click <strong>Connect</strong>. A page asks for your key; <a href="https://www.community-archive.org/settings/api-keys">create one here</a> if you don't have it.</li>
</ul>
<h2>Claude Code</h2>
<pre>claude mcp add --transport http community-archive ${esc(mcp)}</pre>
<p class="muted">Then run <code>/mcp</code> to connect. Clients that can't do OAuth can send the key directly as <code>Authorization: Bearer cak_…</code>.</p>
<h2>Tools</h2>
<div class="tablewrap"><table>${TOOLS.map(([n, d]) => `<tr><td><code>${esc(n)}</code></td><td>${esc(d)}</td></tr>`).join("")}</table></div>
<h2>Limits</h2>
<p>Requests count against your own key's limits: 60 a minute and 20,000 a day. The server retries politely when the archive asks it to slow down.</p>
<p class="muted"><a href="/privacy">Privacy policy</a>${repoUrl ? ` · <a href="${esc(repoUrl)}">Source code</a>` : ""}. Not an official Community Archive service.</p>`,
  );
}

export function privacyPage(contact: string, operator: string): string {
  return layout(
    "Privacy · Community Archive connector",
    `<div class="eyebrow">Privacy policy</div>
<h1>Community Archive connector privacy policy</h1>
<p class="muted">Operated by ${esc(operator)}. Last updated 2026-10-26.</p>
<h2>What this service does</h2>
<p>It lets an AI assistant (such as Claude) query the Community Archive API with your own API key. It reads public archive data on your behalf and returns it to the assistant. It does not write anything to the Community Archive.</p>
<h2>What we store</h2>
<ul>
<li><strong>Your Community Archive API key</strong>, encrypted, inside the authorization grant for each connection you approve. It can be decrypted only with that connection's own tokens, which we store only as hashes. We never display, log, or share it.</li>
<li><strong>A fingerprint of your key</strong> (a one-way hash) to group your connections and replace an old one when you reconnect.</li>
<li><strong>Connection records</strong> for the apps you authorize: the app's registered name and redirect address, granted scope, and expiry times.</li>
</ul>
<p>If you send your key directly in a request header instead of signing in, it is used for that request and not stored.</p>
<h2>What we don't store</h2>
<p>We don't keep your prompts, your assistant's conversations, or the archive results it receives, beyond a short-lived in-memory cache of public archive responses (minutes) to save requests against your limits.</p>
<h2>Who receives data</h2>
<p>Your key and your queries are sent only to the Community Archive API (analytics.community-archive.org) to answer the assistant's requests. The service runs on Cloudflare Workers; Cloudflare processes requests as our infrastructure provider. We don't sell or share data with anyone else.</p>
<h2>Retention</h2>
<p>A connection's records and encrypted key are deleted when it expires (after 30 days without use, and at most one year), when you reconnect the same key to the same app, or when you ask us. Deleting your key on community-archive.org stops it working here immediately.</p>
<h2>Contact</h2>
<p>Questions or deletion requests: ${esc(contact)}.</p>`,
  );
}
