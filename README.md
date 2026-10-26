# community-archive-mcp

An MCP server for the [Community Archive](https://www.community-archive.org) API v1, the open database of uploaded Twitter/X archives. It wraps the keyed API in a small set of tools any MCP client can use, and adds the queries people usually want but the API does not offer directly: dated receipts for a tweet, thread reconstruction, "who said it first", phrase timelines, people search by name or topic, and follow-graph overlap.

The legacy Supabase REST API is retired on 2026-11-19. This server only uses API v1 (`https://analytics.community-archive.org/v1`).

## Setup

1. Create a key at <https://www.community-archive.org/settings/api-keys>.
2. Build:

   ```bash
   npm install
   npm run build
   ```

3. Give the server the key, one of:
   - `CA_API_KEY=cak_...` (or `COMMUNITY_ARCHIVE_API_KEY`)
   - `CA_ENV_FILE=/path/to/.env`, a dotenv file that contains either variable. This keeps the key out of client config files.

### Claude desktop

Add to `claude_desktop_config.json` under `mcpServers`:

```json
"community-archive": {
  "command": "node",
  "args": ["/ABSOLUTE/PATH/community-archive-mcp/dist/index.js"],
  "env": { "CA_ENV_FILE": "~/.hermes/.env" }
}
```

### Claude Code

```bash
claude mcp add community-archive -e CA_ENV_FILE=~/.hermes/.env -- node /ABSOLUTE/PATH/community-archive-mcp/dist/index.js
```

## Tools

All tools are read-only.

### API v1

| Tool | Route | Notes |
| --- | --- | --- |
| `ca_me` | `GET /me` | The key and its limits. |
| `ca_get_tweets` | `GET /tweets/{id}`, `GET /tweets?ids=` | 1–100 IDs **or status URLs**; reports which are missing. |
| `ca_search_tweets` | `GET /tweets/search` | Full text, `from_user`, `reply_to_user`, `since`/`until`, offset paging. |
| `ca_account` | `GET /accounts/{account}`, `GET /accounts?usernames=|ids=` | Accepts `@handle` and profile URLs. |
| `ca_account_tweets` | `GET /accounts/{account}/tweets` | Order, date range, skip replies/retweets, multi-page in one call. |
| `ca_tweets_window` | `GET /tweets?since=&until=` | Everything in a ≤31-day window. |
| `ca_account_relations` | `GET /accounts/{account}/likes|followers|following` | Archive-derived edges. |
| `ca_members` | `GET /members` | Current members. |

Tweets come back **compact** by default (id, permalink, user, date, text with t.co links expanded, counts, reply/quote pointers). Pass `format: "full"` for every API field.

### Extensions

| Tool | What it does | How |
| --- | --- | --- |
| `ca_receipt` | Dated proof record for up to 25 tweets: exact text, timestamp, permalink, author, SHA-256 over `kind\|date\|url\|quote`, and the API `request_id` as provenance. | `GET /tweets/{id}`. The output is the source shape Receipt Cuts animates, and the hash is the one printed on the receipt. |
| `ca_thread` | The reply chain above a tweet plus the author's own continuation below it. | Walks `reply_to_tweet_id` upward; reads the author's timeline for a few days after and keeps replies in the same conversation. Notes parents that are not in the archive. |
| `ca_first_said` | Earliest archived uses of a word or phrase, overall or by one person. | Scans search results (up to 5,000) and sorts by date. Says whether the scan was complete. |
| `ca_phrase_timeline` | Counts per day/week/month/year, first and latest use, top authors. | Same scan, bucketed. Replaces the old `word_occurrences` RPC, which v1 dropped. |
| `ca_who_talks_about` | People search by topic: authors ranked by how often they tweet about it, with first mention and best-received tweet. | Search scan, grouped by author. |
| `ca_find_people` | People search by name: fuzzy, accent-insensitive match on handle and display name. | Caches the member directory for 6 hours; falls back to a direct account lookup for exact handles of non-members. |
| `ca_relation_overlap` | Shared followers or following between two accounts, with Jaccard similarity. | Pages both edge lists. |

## Limits and behavior

- The API allows 60 requests a minute, 20,000 a day, and 2 in flight per key. The client keeps under those, retries `429`/`503` after `Retry-After`, and turns `422` into "narrow the query (add since/until or from_user)".
- GET responses are cached in memory for 10 minutes.
- Scanning tools stop at their `scan` limit. When the scan is incomplete they say so, so a "first said" answer is never presented as definitive when it is not.
- Deleted and opted-out tweets are omitted by the API; a missing tweet is reported as missing, not as an error in the whole call.
- The key never appears in tool output or logs.

## Development

```bash
npm test   # builds, then runs the tests against an in-memory fake of API v1
```
