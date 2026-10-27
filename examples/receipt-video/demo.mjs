#!/usr/bin/env node
// Demo: someone asks for a receipt, the connector's tools run, the receipt prints with the
// timestamp highlighted, and it becomes a sticker.
//
//   node demo.mjs [receipts.json] [--index 1] [--out out/demo.mp4] [--format 9x16]
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createCanvas } from "@napi-rs/canvas";
import { font, registerFonts } from "./lib/fonts.mjs";
import { normalizeReceipts, receiptHash, MARKER } from "./lib/receipt.mjs";
import { FORMATS, drawBackground, makeReceiptScene, pill } from "./lib/scene.mjs";
import { makeSticker } from "./lib/sticker.mjs";
import { renderScene } from "./lib/encode.mjs";
import { clamp, easeInOut, easeOut, easeOutBack, lerp, span } from "./lib/ease.mjs";

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    index: { type: "string", default: "1" },
    out: { type: "string", default: "out/demo.mp4" },
    format: { type: "string", default: "9x16" },
    ask: { type: "string" },
    query: { type: "string", default: "internet 2.0" },
    matches: { type: "string", default: "215" },
    connector: { type: "string", default: "community-archive-mcp.leo-guinan.workers.dev" },
    fps: { type: "string", default: "30" },
  },
});

registerFonts();
const input = positionals[0] || new URL("./samples/leo-receipts.json", import.meta.url).pathname;
const r = normalizeReceipts(JSON.parse(readFileSync(input, "utf8")))[Number(o.index)];
if (!r) throw new Error("No receipt at that index.");
const [W, H] = FORMATS[o.format];
const ui = Math.min(W, H) / 1080;
const cui = ui * (H > W ? 1.22 : 1); // the chat reads larger in a vertical frame
const asOf = r.fetched_at || undefined;
const user = r.handle.replace(/^@/, "");
const ask = o.ask || `Find my first “${o.query.replace(/\b\w/g, (c) => c.toUpperCase())}” tweet and print me a receipt.`;

// ---------- scene 1: the ask ----------
const bg = createCanvas(W, H);
drawBackground(bg.getContext("2d"), W, H, "ink");

function wrapLines(ctx, text, maxW) {
  const out = [];
  let line = "";
  for (const w of text.split(" ")) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > maxW && line) {
      out.push(line);
      line = w;
    } else line = next;
  }
  if (line) out.push(line);
  return out;
}

const shortUrl = r.url.replace(/^https?:\/\//, "").replace(/(\d{6})\d+$/, "$1…");
const json = [
  ["{", null],
  ['  "date": ', `"${r.date}",`],
  ['  "created_at": ', `"${r.created_at.replace(".000", "")}",`, "ts"],
  ['  "quote": ', `"${r.quote.length > 26 ? r.quote.slice(0, 25) + "…" : r.quote}",`],
  ['  "url": ', `"${shortUrl}",`],
  ['  "sha256": ', `"${(r.sha256 || receiptHash(r)).slice(0, 12)}…",`],
  ['  "archive": ', `"match ✓"`],
  ["}", null],
];

const A = { type0: 0.5, type1: 2.6, tool1: 3.0, tool1done: 3.9, tool2: 4.2, tool2done: 5.0, json0: 5.25, json1: 6.3, tsMark: 6.5, say: 7.0, end: 8.4 };

function spinner(ctx, x, y, rad, t, done) {
  ctx.save();
  if (done) {
    ctx.fillStyle = "#2fd39a";
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#0d1a14";
    ctx.lineWidth = rad * 0.28;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x - rad * 0.45, y + rad * 0.02);
    ctx.lineTo(x - rad * 0.1, y + rad * 0.38);
    ctx.lineTo(x + rad * 0.5, y - rad * 0.35);
    ctx.stroke();
  } else {
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = rad * 0.3;
    ctx.beginPath();
    ctx.arc(x, y, rad * 0.8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "#9b86ff";
    ctx.beginPath();
    ctx.arc(x, y, rad * 0.8, t * 7, t * 7 + 1.6);
    ctx.stroke();
  }
  ctx.restore();
}

function toolChip(ctx, x, y, w, t, start, done, name, args, result) {
  const a = easeOut(span(t, start, start + 0.3));
  if (a <= 0) return 0;
  const h = (result && t >= done ? 128 : 92) * cui;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.translate(0, (1 - a) * 20 * cui);
  ctx.fillStyle = "#1a1e30";
  ctx.strokeStyle = "#2e3452";
  ctx.lineWidth = 2 * cui;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 18 * cui);
  ctx.fill();
  ctx.stroke();
  spinner(ctx, x + 44 * cui, y + 46 * cui, 17 * cui, t, t >= done);
  ctx.font = font.mono(700, Math.round(27 * cui));
  ctx.fillStyle = "#e9e7ff";
  ctx.fillText(name, x + 80 * cui, y + 56 * cui);
  const nw = ctx.measureText(name).width;
  ctx.font = font.mono(400, Math.round(23 * cui));
  ctx.fillStyle = "#8f96b8";
  ctx.fillText(args, x + 80 * cui + nw + 16 * cui, y + 56 * cui);
  if (result && t >= done) {
    ctx.font = font.mono(400, Math.round(23 * cui));
    ctx.fillStyle = "#2fd39a";
    ctx.fillText(result, x + 80 * cui, y + 100 * cui);
  }
  ctx.restore();
  return h;
}

function drawAsk(ctx, t) {
  ctx.drawImage(bg, 0, 0);
  const X0 = 70 * cui, X1 = W - 70 * cui, CW = X1 - X0;
  let y = Math.max(140 * cui, H * 0.17);
  // header
  ctx.font = font.sans(700, Math.round(30 * cui));
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.fillText("CLAUDE  +  COMMUNITY ARCHIVE CONNECTOR", X0, y);
  y += 70 * cui;

  // user bubble, typed
  const chars = Math.floor(ask.length * span(t, A.type0, A.type1));
  const shown = ask.slice(0, chars);
  ctx.font = font.sans(600, Math.round(42 * cui));
  const maxW = CW * 0.8;
  const full = wrapLines(ctx, ask, maxW - 64 * cui);
  const lines = wrapLines(ctx, shown || " ", maxW - 64 * cui);
  const bw = Math.min(maxW, Math.max(...full.map((l) => ctx.measureText(l).width)) + 64 * cui);
  const bh = full.length * 56 * cui + 44 * cui;
  const bx = X1 - bw;
  ctx.fillStyle = "#4a35c4";
  ctx.beginPath();
  ctx.roundRect(bx, y, bw, bh, 30 * cui);
  ctx.fill();
  ctx.fillStyle = "#fff";
  lines.forEach((l, i) => ctx.fillText(l, bx + 32 * cui, y + 60 * cui + i * 56 * cui));
  if (t < A.type1 + 0.3 && Math.floor(t * 3) % 2 === 0) {
    const last = lines[lines.length - 1] || "";
    const cx = bx + 32 * cui + ctx.measureText(last).width + 4 * cui;
    ctx.fillRect(cx, y + 24 * cui + (lines.length - 1) * 56 * cui, 4 * cui, 46 * cui);
  }
  y += bh + 60 * cui;

  // assistant
  if (t >= A.tool1 - 0.2) {
    ctx.font = font.sans(700, Math.round(30 * cui));
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.globalAlpha = easeOut(span(t, A.tool1 - 0.2, A.tool1 + 0.1));
    ctx.fillText("Claude", X0, y);
    ctx.globalAlpha = 1;
    y += 30 * cui;
  }
  const h1 = toolChip(ctx, X0, y, CW, t, A.tool1, A.tool1done, "ca_first_said", `"${o.query}" · @${user}`, `earliest of ${o.matches} · ${r.date}`);
  if (h1) y += h1 + 22 * cui;
  const h2 = toolChip(ctx, X0, y, CW, t, A.tool2, A.tool2done, "ca_receipt", `status/${r.tweet_id.slice(0, 8)}…`, "1 receipt · hash matches the archive");
  if (h2) y += h2 + 30 * cui;

  // JSON receipt
  if (t >= A.json0) {
    const n = Math.ceil(json.length * span(t, A.json0, A.json1));
    const lh = 46 * cui, jh = json.length * lh + 50 * cui;
    ctx.save();
    ctx.globalAlpha = easeOut(span(t, A.json0, A.json0 + 0.25));
    ctx.fillStyle = "#0c0e18";
    ctx.beginPath();
    ctx.roundRect(X0, y, CW, jh, 18 * cui);
    ctx.fill();
    ctx.font = font.mono(500, Math.round(27 * cui));
    json.slice(0, n).forEach(([k, v, tag], i) => {
      const ly = y + 52 * cui + i * lh;
      if (tag === "ts") {
        const mk = easeOut(span(t, A.tsMark, A.tsMark + 0.4));
        if (mk > 0) {
          const full = ctx.measureText(k + v).width;
          ctx.fillStyle = MARKER;
          ctx.globalAlpha = 0.9;
          ctx.fillRect(X0 + 28 * cui, ly - 34 * cui, (full + 16 * cui) * mk, 46 * cui);
          ctx.globalAlpha = 1;
        }
      }
      const hot = tag === "ts" && t >= A.tsMark + 0.1;
      ctx.fillStyle = hot ? "#1a1a22" : "#8f96b8";
      ctx.fillText(k, X0 + 36 * cui, ly);
      if (v) {
        ctx.fillStyle = hot ? "#1a1a22" : v.startsWith('"') ? "#ffe08a" : "#e9e7ff";
        ctx.fillText(v, X0 + 36 * cui + ctx.measureText(k).width, ly);
      }
    });
    ctx.restore();
    y += jh + 44 * cui;
  }
  if (t >= A.say) {
    ctx.globalAlpha = easeOut(span(t, A.say, A.say + 0.3));
    ctx.font = font.sans(500, Math.round(40 * cui));
    ctx.fillStyle = "#fff";
    ctx.fillText("Here’s your receipt. Printing it now.", X0, y + 10 * cui);
    ctx.globalAlpha = 1;
  }
}

// ---------- scene 2: the printed receipt ----------
const receiptScene = makeReceiptScene(r, { W, H, asOf, bg: "ink", footer: null });

// ---------- scene 3: the sticker ----------
const sticker = makeSticker(r, { asOf, k: 2 });
const surface = createCanvas(W, H);
{
  const c = surface.getContext("2d");
  const g = c.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#3b3f4a");
  g.addColorStop(1, "#1f2229");
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
  c.fillStyle = "rgba(255,255,255,0.025)";
  for (let i = 0; i < 900; i++) c.fillRect((i * 97.3) % W, (i * 211.7) % H, 2, 2);
}
const ST = { len: 5.2 };
function drawSticker(ctx, t) {
  ctx.drawImage(surface, 0, 0);
  const s0 = Math.min((W * 0.6) / sticker.canvas.width, (H * 0.7) / sticker.canvas.height);
  const u = easeOutBack(span(t, 0.35, 0.85));
  const sc = s0 * lerp(1.45, 1, u);
  const rot = lerp(-0.28, -0.06, easeOut(span(t, 0.35, 0.9)));
  const land = t >= 0.8 && t < 1.0 ? Math.sin(t * 90) * 6 * ui * (1 - (t - 0.8) / 0.2) : 0;
  ctx.save();
  ctx.globalAlpha = clamp(span(t, 0.3, 0.45));
  ctx.translate(W / 2 + land, H * 0.46);
  ctx.rotate(rot);
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = lerp(60, 22, u) * ui;
  ctx.shadowOffsetY = lerp(50, 10, u) * ui;
  const w = sticker.canvas.width * sc, h = sticker.canvas.height * sc;
  ctx.drawImage(sticker.canvas, -w / 2, -h / 2, w, h);
  ctx.restore();
  pill(ctx, "TURN ANY RECEIPT INTO A STICKER", W / 2, H * 0.06, ui, { alpha: span(t, 1.2, 1.5), accent: "#ff8fd1" });
  const a = span(t, 1.9, 2.3);
  if (a > 0) {
    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = font.sans(600, Math.round(32 * ui));
    ctx.fillStyle = "rgba(255,255,255,0.82)";
    const line = "Die-cut PNG · the QR still opens the tweet";
    ctx.fillText(line, W / 2 - ctx.measureText(line).width / 2, H * 0.94);
    ctx.restore();
  }
}

// ---------- scene 4: end card ----------
const EC = { len: 3.8 };
function drawEnd(ctx, t) {
  ctx.drawImage(bg, 0, 0);
  const rows = [
    [0.1, font.sans(700, Math.round(72 * ui)), "#fff", "Receipts from"],
    [0.25, font.sans(700, Math.round(72 * ui)), MARKER, "the Community Archive"],
    [0.8, font.mono(500, Math.round(34 * ui)), "rgba(255,255,255,0.88)", o.connector],
    [1.1, font.sans(500, Math.round(34 * ui)), "rgba(255,255,255,0.7)", "Bring your own Community Archive key."],
    [1.35, font.sans(500, Math.round(34 * ui)), "rgba(255,255,255,0.7)", "Receipts, videos and stickers from any tweet."],
  ];
  let y = H * 0.4;
  for (const [at, f, c, text] of rows) {
    const a = easeOut(span(t, at, at + 0.4));
    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = f;
    ctx.fillStyle = c;
    const tw = ctx.measureText(text).width;
    ctx.fillText(text, W / 2 - tw / 2, y + (1 - a) * 24 * ui);
    ctx.restore();
    y += f.includes("72px") || f.includes(`${Math.round(72 * ui)}px`) ? 92 * ui : 60 * ui;
    if (at === 0.25) y += 50 * ui;
  }
}

// ---------- timeline ----------
const S1 = A.end;                 // ask
const X12 = 0.45;                 // crossfade ask -> receipt
const S2 = receiptScene.duration; // receipt
const X23 = 0.5;
const t2 = S1 - X12, t3 = t2 + S2 - X23, t4 = t3 + ST.len;
const duration = t4 + EC.len;

const layer = createCanvas(W, H);
const lctx = layer.getContext("2d");
function drawLayer(fn, t) {
  lctx.setTransform(1, 0, 0, 1, 0, 0);
  lctx.globalAlpha = 1;
  lctx.globalCompositeOperation = "source-over";
  fn(lctx, t);
  return layer;
}

const scene = {
  duration,
  draw(ctx, t) {
    if (t < t2) return drawAsk(ctx, t);
    if (t < S1) {
      drawAsk(ctx, t);
      ctx.globalAlpha = easeInOut(span(t, t2, S1));
      ctx.drawImage(drawLayer(receiptScene.draw, t - t2), 0, 0);
      ctx.globalAlpha = 1;
      return;
    }
    if (t < t3) return receiptScene.draw(ctx, t - t2);
    if (t < t3 + X23) {
      receiptScene.draw(ctx, t - t2);
      ctx.globalAlpha = easeInOut(span(t, t3, t3 + X23));
      ctx.drawImage(drawLayer(drawSticker, t - t3), 0, 0);
      ctx.globalAlpha = 1;
      return;
    }
    if (t < t4) return drawSticker(ctx, t - t3);
    if (t < t4 + 0.4) {
      drawSticker(ctx, t - t3);
      ctx.globalAlpha = easeInOut(span(t, t4, t4 + 0.4));
      ctx.drawImage(drawLayer(drawEnd, t - t4), 0, 0);
      ctx.globalAlpha = 1;
      return;
    }
    drawEnd(ctx, t - t4);
  },
};

mkdirSync(path.dirname(o.out), { recursive: true });
const t0 = Date.now();
const { seconds } = await renderScene(scene, createCanvas(W, H), o.out, { fps: Number(o.fps) });
console.log(`demo ${o.out}  (${seconds.toFixed(1)}s at ${W}×${H}, rendered in ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
