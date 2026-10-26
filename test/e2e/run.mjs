// End-to-end: run the Worker locally (wrangler dev --env test) against the mock API and walk the
// connect flow the way an MCP client such as Claude does: discovery, registration, PKCE sign-in with
// the key page, token exchange, MCP calls, refresh, direct keys, and the deny path.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { GOOD_KEY, startMockApi } from "./mock-api.mjs";

const WORKER = "http://localhost:8799";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const STATE_DIR = process.env.E2E_STATE_DIR || ".wrangler/e2e-state";
let passed = 0;
const step = (name) => console.log(`✓ ${name}`) || passed++;

const b64url = (buf) => Buffer.from(buf).toString("base64url");

class Jar {
  cookies = new Map();
  take(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function waitFor(url, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const field = (html, name) => html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1]?.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

async function mcp(token, body) {
  const r = await fetch(`${WORKER}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, headers: r.headers, json: text ? JSON.parse(text) : null, text };
}

async function signIn(clientId, verifier, { key, deny = false, jar = new Jar() } = {}) {
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const q = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge,
    code_challenge_method: "S256", state: "st-123", scope: "archive:read", resource: `${WORKER}/mcp`,
  });
  const page = await fetch(`${WORKER}/authorize?${q}`, { redirect: "manual" });
  jar.take(page);
  const html = await page.text();
  return { page, html, jar, q };
}

async function submit(jar, html, extra) {
  const form = new URLSearchParams({ handle: field(html, "handle"), q: field(html, "q"), ...extra });
  const r = await fetch(`${WORKER}/authorize`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: jar.header(), Origin: WORKER },
    body: form,
  });
  jar.take(r);
  return r;
}

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}

async function main() {
  rmSync(STATE_DIR, { recursive: true, force: true });
  const { server: api, seen } = await startMockApi(8798);
  const dev = spawn("npx", ["wrangler", "dev", "--env", "test", "--port", "8799", "--ip", "127.0.0.1", "--persist-to", STATE_DIR, "--log-level", "warn"], {
    stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CLOUDFLARE_CF_FETCH_ENABLED: "false" },
  });
  let log = "";
  dev.stdout.on("data", (d) => (log += d));
  dev.stderr.on("data", (d) => (log += d));
  try {
    await waitFor(`${WORKER}/health`);
    step("worker is up");

    // Landing and privacy pages
    const landing = await (await fetch(`${WORKER}/`)).text();
    assert.match(landing, /http:\/\/localhost:8799\/mcp/);
    assert.match(await (await fetch(`${WORKER}/privacy`)).text(), /test@example.com/);
    step("landing and privacy pages render");

    // 1. Unauthenticated MCP request points at the resource metadata
    const r401 = await fetch(`${WORKER}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(r401.status, 401);
    const challenge = r401.headers.get("www-authenticate") ?? "";
    assert.match(challenge, /resource_metadata="([^"]+)"/);
    step("401 challenge names the resource metadata");

    // 2. Discovery
    const rmUrl = challenge.match(/resource_metadata="([^"]+)"/)[1];
    const rm = await (await fetch(rmUrl)).json();
    assert.equal(rm.resource, `${WORKER}/mcp`);
    const asMeta = await (await fetch(`${rm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
    assert.ok(asMeta.registration_endpoint && asMeta.token_endpoint && asMeta.authorization_endpoint);
    assert.deepEqual(asMeta.code_challenge_methods_supported, ["S256"]);
    step("protected-resource and authorization-server metadata");

    // 3. Dynamic client registration (what "Register automatically" does)
    const reg = await fetch(asMeta.registration_endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Claude <script>alert(1)</script>", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
    });
    assert.equal(reg.status, 201);
    const client = await reg.json();
    step("dynamic client registration");

    // 4. The sign-in page shows who is asking, escaped
    const verifier = b64url(randomBytes(32));
    let { html, jar } = await signIn(client.client_id, verifier);
    assert.match(html, /Connect your Community Archive key/);
    assert.match(html, /claude\.ai/);
    assert.ok(!html.includes("<script>alert(1)</script>"), "client name must be escaped");
    assert.ok(field(html, "handle"));
    // Browsers apply form-action to the redirect after submit, so the app's origin must be allowed.
    const csp = (await fetch(`${WORKER}/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "s", resource: `${WORKER}/mcp` })}`)).headers.get("content-security-policy");
    assert.match(csp, /form-action 'self' https:\/\/claude\.ai;/);
    assert.match(csp, /frame-ancestors 'none'/);
    step("sign-in page shows the app and redirect host, escaped; CSP allows the redirect back");

    // 5. A wrong key is refused and the page comes back with an error
    let r = await submit(jar, html, { decision: "approve", api_key: "cak_wrong_key_0000000000000000" });
    assert.equal(r.status, 400);
    html = await r.text();
    assert.match(html, /didn&#39;t accept that key|didn't accept that key/);
    assert.ok(field(html, "handle"));
    step("wrong key is rejected with a retry page");

    r = await submit(jar, html, { decision: "approve", api_key: "not-a-key" });
    assert.equal(r.status, 400);
    html = await r.text();
    assert.match(html, /start with cak_/);
    step("malformed key is rejected without calling the API");

    // 6. The right key completes the grant
    r = await submit(jar, html, { decision: "approve", api_key: GOOD_KEY });
    assert.equal(r.status, 302, await r.clone().text());
    const back = new URL(r.headers.get("location"));
    assert.equal(back.origin + back.pathname, REDIRECT);
    assert.equal(back.searchParams.get("state"), "st-123");
    assert.ok(back.searchParams.get("code"));
    assert.equal(back.searchParams.get("iss"), WORKER);
    step("correct key redirects back with code, state and iss");

    // 7. Token exchange with PKCE
    const tok = await fetch(asMeta.token_endpoint, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code"), redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier, resource: `${WORKER}/mcp` }),
    });
    assert.equal(tok.status, 200, await tok.clone().text());
    const tokens = await tok.json();
    assert.ok(tokens.access_token && tokens.refresh_token);
    assert.equal(tokens.scope, "archive:read");
    assert.ok(!tokens.access_token.includes("cak_"));
    step("token exchange returns access and refresh tokens (not the key)");

    // 8. MCP over the token
    seen.auth.length = 0;
    let res = await mcp(tokens.access_token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } } });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.result.serverInfo.name, "community-archive");
    assert.match(res.json.result.instructions, /Community Archive/);
    res = await mcp(tokens.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal(res.json.result.tools.length, 15);
    res = await mcp(tokens.access_token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ca_receipt", arguments: { refs: ["https://x.com/leo_guinan/status/2"] } } });
    const receipt = JSON.parse(res.json.result.content[0].text).receipts[0];
    assert.equal(receipt.date, "2024-05-01");
    assert.equal(receipt.sha256, createHash("sha256").update(["tweet", "2024-05-01", "https://x.com/leo_guinan/status/2", "We like movies, not snapshots."].join("|")).digest("hex"));
    res = await mcp(tokens.access_token, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "ca_first_said", arguments: { q: "movies snapshots" } } });
    assert.equal(JSON.parse(res.json.result.content[0].text).earliest[0].id, "1");
    assert.ok(seen.auth.length > 0 && seen.auth.every((a) => a === `Bearer ${GOOD_KEY}`), "upstream must receive the user's key");
    step("MCP initialize, tools/list (15), ca_receipt and ca_first_said over the OAuth token");

    // 9. Refresh
    const ref = await fetch(asMeta.token_endpoint, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id, resource: `${WORKER}/mcp` }),
    });
    assert.equal(ref.status, 200, await ref.clone().text());
    const t2 = await ref.json();
    res = await mcp(t2.access_token, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "ca_me", arguments: {} } });
    assert.equal(res.json.result.isError ?? false, false);
    step("refresh token yields a working access token");

    // 10. Direct key, for clients without OAuth
    res = await mcp(GOOD_KEY, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "ca_get_tweets", arguments: { refs: ["2"] } } });
    assert.equal(res.status, 200, res.text);
    assert.equal(JSON.parse(res.json.result.content[0].text).tweets[0].id, "2");
    res = await mcp("cak_wrong_key_0000000000000000", { jsonrpc: "2.0", id: 7, method: "tools/list" });
    assert.equal(res.status, 401);
    res = await mcp("garbage-token", { jsonrpc: "2.0", id: 8, method: "tools/list" });
    assert.equal(res.status, 401);
    step("direct Bearer cak_ key works; wrong key and junk tokens get 401");

    // 11. Cancel sends access_denied back to the app
    const v2 = b64url(randomBytes(32));
    ({ html, jar } = await signIn(client.client_id, v2));
    r = await submit(jar, html, { decision: "deny" });
    assert.equal(r.status, 302);
    const denied = new URL(r.headers.get("location"));
    assert.equal(denied.searchParams.get("error"), "access_denied");
    assert.equal(denied.searchParams.get("state"), "st-123");
    step("cancel redirects with access_denied");

    // 12. A forged or replayed handle is refused
    ({ html, jar } = await signIn(client.client_id, v2));
    r = await submit(new Jar(), html, { decision: "approve", api_key: GOOD_KEY });
    assert.equal(r.status, 400);
    step("form posted without the browser's consent cookie is refused");

    // 13. Unknown redirect URI is rendered locally, never redirected
    const bad = await fetch(`${WORKER}/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "https://evil.example/cb", code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "s" })}`, { redirect: "manual" });
    assert.equal(bad.status, 400);
    assert.ok(!bad.headers.get("location"));
    step("unregistered redirect URI is refused without redirecting");

    // 14. The key is never stored in plaintext
    await new Promise((r) => setTimeout(r, 500));
    const files = walk(STATE_DIR);
    const leaks = files.filter((f) => readFileSync(f).includes(Buffer.from(GOOD_KEY)));
    assert.deepEqual(leaks, [], "plaintext key found in KV state");
    assert.ok(!log.includes(GOOD_KEY), "key found in worker logs");
    step(`key absent from KV storage (${files.length} files checked) and from logs`);

    console.log(`\n${passed} checks passed`);
  } catch (e) {
    console.error("\nFAILED:", e.message);
    console.error("--- worker log ---\n" + log.slice(-4000));
    process.exitCode = 1;
  } finally {
    try { process.kill(-dev.pid, "SIGTERM"); } catch {}
    api.close();
  }
}

main();
