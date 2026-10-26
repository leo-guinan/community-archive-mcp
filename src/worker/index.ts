// Hosted Community Archive connector (Cloudflare Worker).
//
//  /mcp                         MCP over Streamable HTTP (stateless). Needs a token from our OAuth flow,
//                               or, when ALLOW_DIRECT_KEYS isn't "false", a raw `Bearer cak_...` key.
//  /authorize                   Our sign-in page: shows the app asking, takes the user's archive key,
//                               checks it against /v1/me, and stores it only inside the encrypted grant.
//  /oauth/token, /oauth/register, /.well-known/*   Served by @cloudflare/workers-oauth-provider.
//  /, /privacy, /health         Plain pages.
import { AuthorizationError, CimdFetchError, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CommunityArchiveClient, DEFAULT_BASE_URL } from "../core/client.js";
import { buildServer } from "../core/server.js";
import { checkDirectKey, checkKey, keyFingerprint } from "./keys.js";
import { authorizePage, errorPage, html, landingPage, privacyPage } from "./pages.js";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** Public origin of this Worker, e.g. https://community-archive-mcp.example.workers.dev (no trailing slash). */
  PUBLIC_URL: string;
  CA_API_BASE_URL?: string;
  /** "false" turns off raw `Bearer cak_...` access at /mcp. */
  ALLOW_DIRECT_KEYS?: string;
  /** "false" turns off Client ID Metadata Documents (needed only for local tests without internet). */
  ENABLE_CIMD?: string;
  OPERATOR?: string;
  CONTACT?: string;
  REPO_URL?: string;
}

/** What the grant carries, encrypted, into every MCP request. */
interface Props {
  apiKey: string;
  keyId: string;
  via: "oauth" | "direct";
}

const SCOPE = "archive:read";
const DAY = 86_400;

// Archive responses are public and identical for every key, so isolates share one short cache.
const sharedCache = new Map<string, { at: number; value: any }>();

function base(env: Env) {
  return env.CA_API_BASE_URL || DEFAULT_BASE_URL;
}
function origin(env: Env) {
  return env.PUBLIC_URL.replace(/\/$/, "");
}

// ---------------- MCP ----------------

const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as any).props as Props | undefined;
    if (!props?.apiKey) return new Response("Missing credentials", { status: 401 });
    const client = new CommunityArchiveClient({
      apiKey: props.apiKey,
      baseUrl: base(env),
      cache: sharedCache,
      cacheMax: 2000,
      userAgent: "community-archive-connector/0.2",
      // A Worker request shouldn't sleep for a minute on a 429; retry a little, then report it.
      maxRetries: 2,
      maxRetryWaitMs: 8_000,
    });
    const server = buildServer(client);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      ctx.waitUntil(server.close().catch(() => {}));
    }
  },
};

// ---------------- sign-in page ----------------

async function showAuthorize(request: Request, env: Env, error?: string): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const authReq = await oauth.parseAuthRequest(request);
  const facts = await oauth.describeConsent(authReq);
  const consent = await oauth.beginConsent(authReq);
  const query = new URL(request.url).search.replace(/^\?/, "");
  return html(authorizePage({ facts, handle: consent.handle, query, error }), error ? 400 : 200, consent.headers);
}

async function submitAuthorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  const query = String(form.get("q") ?? "");

  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }

  const apiKey = String(form.get("api_key") ?? "").trim();
  const check = await checkKey(apiKey, base(env));
  if (!check.ok) {
    // Show the page again for the same client request. The unused handle simply expires.
    const retry = new Request(`${new URL(request.url).origin}/authorize?${new URLSearchParams(query)}`, {
      method: "GET",
      headers: request.headers,
    });
    return showAuthorize(retry, env, check.message);
  }

  const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
  const keyId = await keyFingerprint(apiKey);
  const props: Props = { apiKey, keyId, via: "oauth" };
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: `key-${keyId}`,
    metadata: { keyId },
    scope: [SCOPE],
    props,
  });
  approved.headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}

const pages = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/authorize") {
        if (request.method === "GET") return await showAuthorize(request, env);
        if (request.method === "POST") return await submitAuthorize(request, env);
        return new Response("Method not allowed", { status: 405 });
      }
    } catch (e) {
      if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
      if (e instanceof AuthorizationError) return html(errorPage("This sign-in link can't be used", e.description), 400);
      if (e instanceof CimdFetchError) return html(errorPage("This app couldn't be verified", "Its client metadata couldn't be fetched."), 400);
      throw e;
    }
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Not found", { status: 404 });
    if (url.pathname === "/") return html(landingPage(origin(env), env.REPO_URL), 200, new Headers({ "Cache-Control": "public, max-age=300" }));
    if (url.pathname === "/privacy")
      return html(
        privacyPage(env.CONTACT || "open an issue in the source repository", env.OPERATOR || "an independent maintainer"),
        200,
        new Headers({ "Cache-Control": "public, max-age=300" }),
      );
    if (url.pathname === "/health") return Response.json({ ok: true });
    return new Response("Not found", { status: 404 });
  },
};

// ---------------- provider ----------------

let provider: OAuthProvider<Env> | null = null;
let providerFor = "";

function getProvider(env: Env): OAuthProvider<Env> {
  const o = origin(env);
  if (provider && providerFor === o) return provider;
  providerFor = o;
  provider = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpHandler as any,
    defaultHandler: pages as any,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: env.ENABLE_CIMD !== "false",
    scopesSupported: [SCOPE],
    requiredScopes: [SCOPE],
    resourceMetadata: { resource: `${o}/mcp`, authorization_servers: [o] } as any,
    accessTokenTTL: 3600,
    refreshTokenTTL: 365 * DAY,
    refreshTokenIdleTTL: 30 * DAY,
    clientRegistrationTTL: 90 * DAY,
    resolveExternalToken: async ({ token, env }) => {
      if (env.ALLOW_DIRECT_KEYS === "false" || !token.startsWith("cak_")) return null;
      const r = await checkDirectKey(token, base(env));
      if (!r.ok) return null;
      const props: Props = { apiKey: token, keyId: await keyFingerprint(token), via: "direct" };
      return { props, audience: `${origin(env)}/mcp` };
    },
  } as any);
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return getProvider(env).fetch(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(getProvider(env).purgeExpiredData(env));
  },
} satisfies ExportedHandler<Env>;
