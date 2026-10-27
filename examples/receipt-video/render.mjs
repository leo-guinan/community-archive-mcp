#!/usr/bin/env node
// Turn Community Archive receipts into printed-receipt MP4s and die-cut stickers.
//
//   node render.mjs receipts.json                 # every receipt -> out/receipt-<id>-9x16.mp4
//   node render.mjs receipts.json --sticker       # also out/sticker-<id>.png (+ preview)
//   cat receipts.json | node render.mjs -         # JSON on stdin (e.g. pasted from Claude)
//   node render.mjs --tweet https://x.com/u/status/123   # fetch it yourself (needs CA_API_KEY)
//
// Input is what the connector's ca_receipt tool returns: {"receipts":[...]}, an array, or one receipt.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createCanvas } from "@napi-rs/canvas";
import { normalizeReceipts, receiptHash } from "./lib/receipt.mjs";
import { FORMATS, makeReceiptScene } from "./lib/scene.mjs";
import { renderScene } from "./lib/encode.mjs";
import { makeSticker, stickerPreview } from "./lib/sticker.mjs";

const HELP = `Usage: node render.mjs <receipts.json | -> [options]
       node render.mjs --tweet <url-or-id> [--tweet ...] [options]

Options
  --format 9x16|16x9|1x1|4x5   Video shape (default 9x16)
  --bg ink|green|black|white   Background (default ink; green for keying)
  --index N                    Only the Nth receipt (0-based)
  --sticker                    Also write a die-cut sticker PNG and a preview
  --no-video                   Skip the MP4 (stickers only)
  --as-of YYYY-MM-DD           Date used for "on record" (default: when fetched, else today)
  --fps 30  --crf 18           Encoding settings
  --out DIR                    Output folder (default ./out)
  --no-captions                Hide the on-screen labels
`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    format: { type: "string", default: "9x16" },
    bg: { type: "string", default: "ink" },
    index: { type: "string" },
    sticker: { type: "boolean", default: false },
    "no-video": { type: "boolean", default: false },
    "as-of": { type: "string" },
    fps: { type: "string", default: "30" },
    crf: { type: "string", default: "18" },
    out: { type: "string", default: "out" },
    "no-captions": { type: "boolean", default: false },
    tweet: { type: "string", multiple: true },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (o.help || (!positionals.length && !o.tweet)) {
  process.stdout.write(HELP);
  process.exit(o.help ? 0 : 1);
}
if (!FORMATS[o.format]) {
  console.error(`Unknown --format ${o.format}. Use one of: ${Object.keys(FORMATS).join(", ")}`);
  process.exit(1);
}

async function fetchReceipts(refs) {
  const key = process.env.CA_API_KEY || process.env.COMMUNITY_ARCHIVE_API_KEY;
  if (!key) throw new Error("--tweet needs CA_API_KEY (create one at https://www.community-archive.org/settings/api-keys).");
  let fmt;
  try {
    fmt = await import(new URL("../../dist/core/format.js", import.meta.url));
  } catch {
    throw new Error("--tweet uses the connector's receipt code. Run `npm install && npm run build` in the repository root first, or pass receipt JSON from ca_receipt instead.");
  }
  const base = process.env.CA_API_BASE_URL || "https://analytics.community-archive.org/v1";
  const out = [];
  for (const ref of refs) {
    const id = fmt.parseTweetRef(ref);
    const res = await fetch(`${base}/tweets/${id}`, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.data) throw new Error(`Tweet ${id}: ${body?.error?.message ?? `HTTP ${res.status}`}`);
    out.push(fmt.toReceipt(body.data, { request_id: body.request_id }));
  }
  return out;
}

function readInput(p) {
  const text = p === "-" ? readFileSync(0, "utf8") : readFileSync(p, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${p === "-" ? "stdin" : p} isn't JSON. Paste the full result of ca_receipt.`);
  }
}

async function main() {
  let receipts = o.tweet ? await fetchReceipts(o.tweet) : [];
  for (const p of positionals) receipts.push(...normalizeReceipts(readInput(p)));
  receipts = normalizeReceipts(receipts);
  if (o.index !== undefined) receipts = [receipts[Number(o.index)]].filter(Boolean);
  if (!receipts.length) throw new Error("No receipts found in the input.");
  mkdirSync(o.out, { recursive: true });
  const [W, H] = FORMATS[o.format];
  const fps = Number(o.fps);

  for (const r of receipts) {
    const id = r.tweet_id || receiptHash(r).slice(0, 12);
    const asOf = o["as-of"] || r.fetched_at || undefined;
    const check = r.sha256 ? (receiptHash(r) === r.sha256 ? "hash matches the archive" : "HASH DOES NOT MATCH (quote edited?)") : "no archive hash";
    console.log(`• ${r.date} ${r.handle} ${JSON.stringify(r.quote.slice(0, 60))}  [${check}]`);
    if (!o["no-video"]) {
      const scene = makeReceiptScene(r, { W, H, asOf, bg: o.bg, captions: !o["no-captions"] });
      const file = path.join(o.out, `receipt-${id}-${o.format}${o.bg === "ink" ? "" : "-" + o.bg}.mp4`);
      const t0 = Date.now();
      const { seconds } = await renderScene(scene, createCanvas(W, H), file, { fps, crf: Number(o.crf) });
      console.log(`  video   ${file}  (${seconds.toFixed(1)}s, rendered in ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }
    if (o.sticker) {
      const st = makeSticker(r, { asOf });
      const file = path.join(o.out, `sticker-${id}.png`);
      writeFileSync(file, st.canvas.toBuffer("image/png"));
      const prev = path.join(o.out, `sticker-${id}-preview.png`);
      writeFileSync(prev, stickerPreview(st).toBuffer("image/png"));
      console.log(`  sticker ${file}  (${st.canvas.width}×${st.canvas.height}px, transparent; prints sharp up to ${st.inches.w.toFixed(1)}×${st.inches.h.toFixed(1)} in)`);
      console.log(`  preview ${prev}`);
    }
  }
}

main().catch((e) => {
  console.error(`receipt-video: ${e.message}`);
  process.exit(1);
});
