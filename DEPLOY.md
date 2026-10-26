# Deploying the hosted connector

The connector is one Cloudflare Worker and one KV namespace. It fits the Workers free plan for light use; the bundle is about 310 KB gzipped.

## 1. Sign in to Cloudflare

```bash
npm install
npx wrangler login
```

## 2. Create the KV namespace

```bash
npx wrangler kv namespace create OAUTH_KV
```

Put the `id` it prints into `wrangler.jsonc` in place of `REPLACE_WITH_KV_NAMESPACE_ID`.

## 3. Set the public URL and the operator details

In `wrangler.jsonc` under `vars`:

| Variable | Set it to |
| --- | --- |
| `PUBLIC_URL` | The origin the Worker is served from, no trailing slash: `https://community-archive-mcp.<subdomain>.workers.dev`, or a custom domain. It becomes the OAuth issuer and the `/mcp` resource, so changing it later means everyone reconnects. |
| `OPERATOR` | The name shown on the privacy page. |
| `CONTACT` | An email address for privacy and deletion requests. |
| `REPO_URL` | The public source repository, shown on the landing page. |
| `ALLOW_DIRECT_KEYS` | `"true"` to accept `Bearer cak_...` at `/mcp`, `"false"` for OAuth only. |

To use a custom domain, add it under `routes` (`{ "pattern": "mcp.example.org", "custom_domain": true }`) and set `PUBLIC_URL` to match.

## 4. Deploy

```bash
npx wrangler deploy
```

Then check:

```bash
curl https://<host>/health                                   # {"ok":true}
curl https://<host>/.well-known/oauth-authorization-server   # endpoints, S256, client_id_metadata_document_supported
curl -i -X POST https://<host>/mcp                           # 401 with a resource_metadata challenge
```

## 5. Test it in Claude

**Customize → Connectors → Add custom connector**, paste `https://<host>/mcp`, leave authentication on the default, then **Connect**. Enter a real key on the sign-in page. In a chat, ask for something like "use ca_me" and "give me a receipt for https://x.com/<handle>/status/<id>".

## Operating it

- **Cleanup.** A daily cron (`17 7 * * *`) purges expired grants, tokens and client registrations.
- **Logs.** Workers observability is on. The code never logs keys or tokens; don't add logging of request headers.
- **Grant lifetimes.** Access tokens last an hour. A connection stays alive while it's used at least every 30 days, for up to a year, then the user reconnects.
- **Revoking everything.** Deleting the KV namespace's contents disconnects every user. Users can always cut access themselves by deleting their key on community-archive.org.
- **Rate limits** are per user key, enforced by the archive. The connector doesn't add a key of its own.

## Submitting to the Connectors Directory (later)

Once it's been used for a while, it can be submitted at [claude.ai/directory/manage](https://claude.ai/directory/manage). It already meets the technical requirements: remote HTTPS server, OAuth 2.0, every tool has a `title` and `readOnlyHint`. You'll also need the privacy policy URL (`https://<host>/privacy`), documentation URL, an icon, a support contact, and a test API key for reviewers. If the Community Archive team takes it over, they should be the ones to submit it.
