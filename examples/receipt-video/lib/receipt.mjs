// A thermal "receipt of record" for one archived tweet, laid out once and drawn at any scale.
// Units are receipt pixels: the paper is RW wide. Anchors give the timestamp, quote and QR
// positions so the video camera, the highlight and the stamp can target them.
import { createCanvas } from "@napi-rs/canvas";
import QRCode from "qrcode";
import { createHash } from "node:crypto";
import { font, registerFonts } from "./fonts.mjs";

export const RW = 760;
const PAD = 56;
const INNER = RW - PAD * 2;
export const PAPER = "#f4f2ea";
export const INK = "#26252d";
const INK_SOFT = "#5d5b66";
export const MARKER = "#ffe14d";
export const STAMP_INK = "#5b2fd6";
const TOOTH = 22; // zigzag tooth width
const TOOTH_H = 14;

/** Same formula as the connector's ca_receipt and Receipt Cuts: sha256(kind|date|url|quote). */
export function receiptHash(r) {
  return createHash("sha256").update([r.kind || "tweet", r.date, r.url, r.quote].join("|")).digest("hex");
}

/** Accept ca_receipt output ({receipts:[...]}), an array, or one receipt. */
export function normalizeReceipts(json) {
  const list = Array.isArray(json) ? json : Array.isArray(json?.receipts) ? json.receipts : [json];
  return list
    .filter((r) => r && typeof r.quote === "string" && r.url && (r.date || r.created_at))
    .map((r) => ({
      kind: r.kind || "tweet",
      date: String(r.date || r.created_at).slice(0, 10),
      created_at: r.created_at || `${String(r.date).slice(0, 10)}T00:00:00.000Z`,
      title: r.title || "Post",
      author: r.author || "",
      handle: r.handle || "",
      quote: r.quote,
      url: r.url,
      sha256: r.sha256 || null,
      tweet_id: r.tweet_id || (String(r.url).match(/status\/(\d+)/) || [])[1] || "",
      likes: r.likes ?? null,
      retweets: r.retweets ?? null,
      request_id: r.provenance?.request_id || r.request_id || null,
      fetched_at: r.provenance?.fetched_at || r.fetched_at || null,
    }));
}

const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
const DAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];

export function stampParts(created_at) {
  const d = new Date(created_at);
  const iso = d.toISOString();
  return {
    timestamp: `${iso.slice(0, 10)}  ${iso.slice(11, 19)} UTC`,
    long: `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`,
    stampDate: `${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCDate()} ${d.getUTCFullYear()}`,
  };
}

export function ageOnRecord(created_at, asOf) {
  const a = new Date(created_at), b = new Date(asOf);
  const days = Math.max(0, Math.floor((b - a) / 86_400_000));
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) months--;
  months = Math.max(0, months);
  const y = Math.floor(months / 12), m = months % 12;
  const label = y ? `${y} YR ${m} MO` : m ? `${m} MO` : `${days} DAY${days === 1 ? "" : "S"}`;
  return { days, label };
}

// Deterministic noise so renders are reproducible.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
function seedOf(text) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function wrap(ctx, text, maxW) {
  const lines = [];
  for (const para of text.split(/\n/)) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue;
      const next = line + word;
      if (ctx.measureText(next.trimEnd()).width <= maxW) {
        line = next;
        continue;
      }
      if (line.trim()) lines.push(line.trimEnd());
      line = /^\s+$/.test(word) ? "" : word;
      // Break tokens (URLs) that are wider than the line on their own.
      while (ctx.measureText(line).width > maxW) {
        let i = line.length;
        while (i > 1 && ctx.measureText(line.slice(0, i)).width > maxW) i--;
        lines.push(line.slice(0, i));
        line = line.slice(i);
      }
    }
    if (line.trim()) lines.push(line.trimEnd());
    else if (!lines.length || para === "") lines.push("");
  }
  return lines;
}

function qrMatrix(url) {
  const q = QRCode.create(url, { errorCorrectionLevel: "M" });
  return { size: q.modules.size, at: (x, y) => q.modules.get(x, y) };
}

/**
 * Build the receipt layout.
 * opts.asOf: date for "on record" (default: now). opts.topTear: zigzag top edge too (stickers).
 */
export function layoutReceipt(r, opts = {}) {
  registerFonts();
  const asOf = opts.asOf ? new Date(opts.asOf) : new Date();
  const m = createCanvas(10, 10).getContext("2d");
  const blocks = [];
  const anchors = {};
  let y = opts.topTear ? 52 : 40;
  const add = (h, draw, name) => {
    if (name) anchors[name] = { x: PAD, y, w: INNER, h };
    blocks.push({ y, h, draw });
    y += h;
  };
  const gap = (h) => (y += h);
  const center = (ctx, text, cy) => ctx.fillText(text, RW / 2 - ctx.measureText(text).width / 2, cy);
  const rule = () => add(30, (ctx, by) => {
    ctx.save();
    ctx.strokeStyle = INK_SOFT;
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 9]);
    ctx.beginPath();
    ctx.moveTo(PAD, by + 15);
    ctx.lineTo(RW - PAD, by + 15);
    ctx.stroke();
    ctx.restore();
  });
  const kv = (k, v) => add(40, (ctx, by) => {
    ctx.font = font.mono(500, 26);
    ctx.fillStyle = INK_SOFT;
    ctx.fillText(k, PAD, by + 29);
    ctx.font = font.mono(700, 26);
    ctx.fillStyle = INK;
    const w = ctx.measureText(v).width;
    ctx.fillText(v, RW - PAD - w, by + 29);
  });

  const computed = receiptHash(r);
  const verified = r.sha256 ? r.sha256 === computed : null;
  const parts = stampParts(r.created_at);
  const age = ageOnRecord(r.created_at, asOf);

  // Header
  add(34, (ctx, by) => { ctx.font = font.mono(500, 22); ctx.fillStyle = INK_SOFT; center(ctx, "COMMUNITY  ARCHIVE", by + 24); });
  add(54, (ctx, by) => { ctx.font = font.mono(700, 40); ctx.fillStyle = INK; center(ctx, "RECEIPT OF RECORD", by + 42); });
  gap(6);
  rule();
  kv("TYPE", (r.title || "Post").toUpperCase().slice(0, 24));
  if (r.handle) kv("FROM", r.handle);
  if (r.author) kv("NAME", r.author.slice(0, 26));
  rule();

  // Timestamp (the thing the video highlights)
  add(34, (ctx, by) => { ctx.font = font.mono(500, 22); ctx.fillStyle = INK_SOFT; ctx.fillText("POSTED", PAD, by + 24); });
  m.font = font.mono(700, 40);
  const tsW = Math.min(INNER, m.measureText(parts.timestamp).width);
  add(58, (ctx, by) => { ctx.font = font.mono(700, 40); ctx.fillStyle = INK; ctx.fillText(parts.timestamp, PAD, by + 43); }, "timestamp");
  anchors.timestamp.w = tsW;
  add(36, (ctx, by) => { ctx.font = font.mono(400, 22); ctx.fillStyle = INK_SOFT; ctx.fillText(parts.long, PAD, by + 26); });
  rule();

  // Quote
  m.font = font.mono(500, 32);
  const qLines = wrap(m, `“${r.quote}”`, INNER);
  const qLH = 46;
  add(qLines.length * qLH + 8, (ctx, by) => {
    ctx.font = font.mono(500, 32);
    ctx.fillStyle = INK;
    qLines.forEach((l, i) => ctx.fillText(l, PAD, by + 36 + i * qLH));
  }, "quote");
  rule();

  // Facts
  kv("ON RECORD", age.label);
  kv("DAYS", age.days.toLocaleString("en-US"));
  if (r.likes !== null && r.likes !== undefined) kv("LIKES · REPOSTS", `${r.likes} · ${r.retweets ?? 0}`);
  rule();

  // Space reserved for the PROOF stamp, like a signature box.
  add(206, (ctx, by) => {
    ctx.font = font.mono(500, 20);
    ctx.fillStyle = INK_SOFT;
    ctx.fillText("STAMPED ON RECORD", PAD, by + 26);
  }, "stamp");
  rule();

  // Proof
  add(34, (ctx, by) => { ctx.font = font.mono(500, 22); ctx.fillStyle = INK_SOFT; ctx.fillText("SHA-256", PAD, by + 24); });
  const groups = computed.match(/.{8}/g);
  add(76, (ctx, by) => {
    ctx.font = font.mono(500, 26);
    ctx.fillStyle = INK;
    ctx.fillText(groups.slice(0, 4).join(" "), PAD, by + 30);
    ctx.fillText(groups.slice(4).join(" "), PAD, by + 66);
  });
  add(42, (ctx, by) => {
    ctx.font = font.mono(700, 24);
    ctx.fillStyle = verified === false ? "#a3261b" : INK;
    const t = verified === true ? "MATCHES COMMUNITY ARCHIVE ✓" : verified === false ? "EDITED SINCE ARCHIVE ✗" : "NO ARCHIVE HASH TO CHECK";
    ctx.fillText(t, PAD, by + 30);
  });
  if (r.request_id) add(32, (ctx, by) => { ctx.font = font.mono(400, 18); ctx.fillStyle = INK_SOFT; ctx.fillText(`REQ ${r.request_id}`, PAD, by + 22); });
  rule();

  // QR to the original tweet
  const qr = qrMatrix(r.url);
  const quiet = 3;
  const mod = 7;
  const qrPx = (qr.size + quiet * 2) * mod;
  m.font = font.mono(400, 19);
  const urlLines = wrap(m, r.url.replace(/^https?:\/\//, ""), INNER - qrPx - 24);
  add(qrPx + 8, (ctx, by) => {
    ctx.fillStyle = PAPER;
    ctx.fillRect(PAD, by, qrPx, qrPx);
    ctx.fillStyle = INK;
    for (let yy = 0; yy < qr.size; yy++)
      for (let xx = 0; xx < qr.size; xx++)
        if (qr.at(xx, yy)) ctx.fillRect(PAD + (xx + quiet) * mod, by + (yy + quiet) * mod, mod + 0.4, mod + 0.4);
    const tx = PAD + qrPx + 24;
    ctx.font = font.mono(700, 24);
    ctx.fillText("SCAN FOR", tx, by + 52);
    ctx.fillText("THE ORIGINAL", tx, by + 84);
    ctx.font = font.mono(400, 19);
    ctx.fillStyle = INK_SOFT;
    urlLines.forEach((l, i) => ctx.fillText(l, tx, by + 124 + i * 26));
  }, "qr");
  anchors.qr.w = qrPx;
  anchors.qr.h = qrPx;
  rule();

  add(34, (ctx, by) => { ctx.font = font.mono(500, 22); ctx.fillStyle = INK; center(ctx, "KEEP THIS RECEIPT", by + 24); });
  add(30, (ctx, by) => { ctx.font = font.mono(400, 18); ctx.fillStyle = INK_SOFT; center(ctx, "community-archive.org", by + 20); });
  y += 34 + TOOTH_H;

  return {
    receipt: r,
    width: RW,
    height: Math.ceil(y),
    blocks,
    anchors,
    verified,
    hash: computed,
    stampDate: parts.stampDate,
    topTear: !!opts.topTear,
  };
}

/** The paper outline: straight or torn top, torn bottom. */
export function paperPath(ctx, L) {
  const H = L.height;
  ctx.beginPath();
  if (L.topTear) {
    ctx.moveTo(0, TOOTH_H);
    for (let x = 0; x < RW; x += TOOTH) {
      ctx.lineTo(Math.min(RW, x + TOOTH / 2), 0);
      ctx.lineTo(Math.min(RW, x + TOOTH), TOOTH_H);
    }
  } else {
    ctx.moveTo(0, 0);
    ctx.lineTo(RW, 0);
  }
  ctx.lineTo(RW, H - TOOTH_H);
  for (let x = RW; x > 0; x -= TOOTH) {
    ctx.lineTo(Math.max(0, x - TOOTH / 2), H);
    ctx.lineTo(Math.max(0, x - TOOTH), H - TOOTH_H);
  }
  ctx.closePath();
}

/** Render the full receipt to its own canvas at scale k (transparent outside the paper). */
export function renderReceipt(L, k = 2, { highlight = 0 } = {}) {
  const c = createCanvas(Math.ceil(RW * k), Math.ceil(L.height * k));
  const ctx = c.getContext("2d");
  ctx.scale(k, k);
  paperPath(ctx, L);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, RW, L.height);
  // faint thermal-paper grain
  const rand = rng(seedOf(L.receipt.url));
  ctx.fillStyle = "rgba(60,55,40,0.035)";
  for (let i = 0; i < (RW * L.height) / 180; i++) ctx.fillRect(rand() * RW, rand() * L.height, 1.6, 1.6);
  if (highlight > 0) drawHighlight(ctx, L, highlight);
  for (const b of L.blocks) b.draw(ctx, b.y);
  ctx.restore();
  return c;
}

/** Yellow marker over the timestamp, swept left to right (0..1). Multiply keeps the ink dark. */
export function drawHighlight(ctx, L, t) {
  const a = L.anchors.timestamp;
  const x0 = a.x - 12, w = (a.w + 24) * Math.min(1, t);
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = MARKER;
  ctx.beginPath();
  const top = a.y + 4, bot = a.y + a.h - 2;
  ctx.moveTo(x0, top + 3);
  ctx.lineTo(x0 + w, top);
  ctx.lineTo(x0 + w - 4, bot);
  ctx.lineTo(x0 + 2, bot - 2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** A rough purple "PROOF" stamp with the post date, as its own image (scale k). */
export function renderStamp(L, k = 2) {
  registerFonts();
  const w = 430, h = 210;
  const c = createCanvas(w * k, h * k);
  const ctx = c.getContext("2d");
  ctx.scale(k, k);
  ctx.strokeStyle = STAMP_INK;
  ctx.fillStyle = STAMP_INK;
  ctx.lineWidth = 11;
  const r = 18;
  ctx.beginPath();
  ctx.roundRect(8, 8, w - 16, h - 16, r);
  ctx.stroke();
  ctx.font = font.stencil(118);
  const t = "PROOF";
  ctx.fillText(t, w / 2 - ctx.measureText(t).width / 2, 122);
  ctx.fillRect(30, 136, w - 60, 6);
  ctx.font = font.stencil(48);
  const d = L.stampDate;
  ctx.fillText(d, w / 2 - ctx.measureText(d).width / 2, 186);
  // wear: knock out specks so it reads as ink, not vector
  const rand = rng(seedOf(L.hash));
  ctx.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 1400; i++) {
    ctx.globalAlpha = 0.25 + rand() * 0.6;
    const s = 0.6 + rand() * 2.6;
    ctx.fillRect(rand() * w, rand() * h, s, s);
  }
  return c;
}
