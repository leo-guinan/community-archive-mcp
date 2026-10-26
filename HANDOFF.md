# Handing this to the Community Archive team

This connector was built outside the Community Archive project so people could use the archive from Claude and other MCP clients with their own API keys. The aim is to hand it over once it has proven useful, so it lives with the people who run the archive.

## What there is

- One TypeScript codebase: a shared core (API client, 15 tools, receipts), a stdio entry point for local use, and a Cloudflare Worker entry point for the hosted connector.
- Only API v1 is used, so nothing breaks when the Supabase REST API is retired on 2026-11-19.
- Unit tests for every tool, and an end-to-end test of the full OAuth connect flow that runs offline against a mock of v1.

## How it fits the archive

- Users bring their own `cak_` key, created at `/settings/api-keys`. Each user's calls count against their own key's limits; the connector has no key of its own.
- It reads only. It doesn't touch archive uploads, opt-outs or anything behind a member's sign-in.
- It identifies itself as `User-Agent: community-archive-connector/0.2` (hosted) and `community-archive-mcp/0.2` (local), so its traffic can be told apart.

## Ways to take it over

1. **Move the repository** to the Community Archive organization on GitHub.
2. **Deploy under your own Cloudflare account and domain**, for example `mcp.community-archive.org`, following [DEPLOY.md](DEPLOY.md). Then point people at the new URL. The interim deployment can redirect its landing page there and be retired after a notice period. Existing users reconnect once.
3. **Optionally, sign in with Community Archive accounts instead of pasted keys.** The sign-in page is the one piece designed to be replaced. If the archive offered OAuth (or an endpoint that mints a key for a signed-in member), `/authorize` could send people to community-archive.org and receive a key or token back, using the library's `beginUpstream()` and `finishUpstream()` helpers. Users would then never handle a key. The rest of the server would not change.
4. **Submit it to the Claude Connectors Directory** as the official connector ([DEPLOY.md](DEPLOY.md) lists what's needed).

## Open questions for the maintainers

- Should a connector key have its own scope or rate-limit class in v1?
- Would v1 add account search by name? `ca_find_people` currently scans `/members` and caches it for six hours.
- Is there an endpoint for word counts over time planned? `ca_phrase_timeline` approximates the retired `word_occurrences` RPC by scanning search results, which is capped at 5,000 results.
- Are the follow and like edge field names stable? `ca_relation_overlap` reads them defensively.
