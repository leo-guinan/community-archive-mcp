// Checking a Community Archive key against the API before we accept it.
import { DEFAULT_BASE_URL } from "../core/client.js";

export const KEY_PATTERN = /^cak_[A-Za-z0-9_-]{16,256}$/;

export type KeyCheck =
  | { ok: true; me: any }
  | { ok: false; reason: "format" | "rejected" | "unavailable"; message: string };

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A short, non-reversible label for a key, safe to show and log. */
export async function keyFingerprint(apiKey: string): Promise<string> {
  return (await sha256Hex(`ca-key:${apiKey}`)).slice(0, 16);
}

export async function checkKey(apiKey: string, baseUrl = DEFAULT_BASE_URL, fetchImpl: typeof fetch = (i, n) => fetch(i, n)): Promise<KeyCheck> {
  const key = apiKey.trim();
  if (!KEY_PATTERN.test(key)) {
    return { ok: false, reason: "format", message: "That doesn't look like a Community Archive key. Keys start with cak_." };
  }
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/me`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": "community-archive-connector/0.2" },
    });
  } catch {
    return { ok: false, reason: "unavailable", message: "Couldn't reach the Community Archive to check the key. Try again in a moment." };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "rejected", message: "The Community Archive didn't accept that key. Check it, or create a new one." };
  }
  if (!res.ok) {
    return { ok: false, reason: "unavailable", message: `The Community Archive couldn't check the key right now (HTTP ${res.status}). Try again in a moment.` };
  }
  let me: any = null;
  try {
    me = ((await res.json()) as any)?.data ?? null;
  } catch {
    me = null;
  }
  return { ok: true, me };
}

// Direct keys (Authorization: Bearer cak_...) are checked once, then remembered briefly per isolate
// by fingerprint so each MCP request doesn't spend an API call on validation.
const directKeyCache = new Map<string, number>();
const DIRECT_TTL_MS = 5 * 60_000;

export async function checkDirectKey(apiKey: string, baseUrl?: string): Promise<KeyCheck> {
  const fp = await keyFingerprint(apiKey);
  const at = directKeyCache.get(fp);
  if (at && Date.now() - at < DIRECT_TTL_MS) return { ok: true, me: null };
  const r = await checkKey(apiKey, baseUrl);
  if (r.ok) {
    directKeyCache.set(fp, Date.now());
    if (directKeyCache.size > 5000) directKeyCache.delete(directKeyCache.keys().next().value!);
  }
  return r;
}
