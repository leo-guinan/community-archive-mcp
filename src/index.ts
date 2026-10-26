#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CommunityArchiveClient, loadDotEnv } from "./client.js";
import { buildServer } from "./server.js";

function resolveKey(): string {
  const direct = process.env.CA_API_KEY ?? process.env.COMMUNITY_ARCHIVE_API_KEY;
  if (direct) return direct;
  const file = process.env.CA_ENV_FILE?.replace(/^~(?=\/)/, homedir());
  if (file) {
    try {
      const env = loadDotEnv(readFileSync(file, "utf8"));
      const k = env.CA_API_KEY ?? env.COMMUNITY_ARCHIVE_API_KEY;
      if (k) return k;
      throw new Error(`${file} has no CA_API_KEY or COMMUNITY_ARCHIVE_API_KEY.`);
    } catch (e: any) {
      throw new Error(`Could not read the API key from CA_ENV_FILE: ${e.message}`);
    }
  }
  throw new Error(
    "No API key. Set CA_API_KEY (or COMMUNITY_ARCHIVE_API_KEY), or CA_ENV_FILE pointing at a .env file that contains it. Create a key at https://www.community-archive.org/settings/api-keys.",
  );
}

async function main() {
  const client = new CommunityArchiveClient({ apiKey: resolveKey(), baseUrl: process.env.CA_API_BASE_URL });
  const server = buildServer(client);
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write(`community-archive-mcp: ${e?.message ?? e}\n`);
  process.exit(1);
});
