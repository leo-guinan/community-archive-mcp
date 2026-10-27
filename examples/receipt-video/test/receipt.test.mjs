import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createCanvas } from "@napi-rs/canvas";
import jsQR from "jsqr";
import { layoutReceipt, normalizeReceipts, receiptHash, renderReceipt, RW } from "../lib/receipt.mjs";
import { makeReceiptScene } from "../lib/scene.mjs";
import { makeSticker } from "../lib/sticker.mjs";
import { renderScene } from "../lib/encode.mjs";

const sample = JSON.parse(readFileSync(new URL("../samples/leo-receipts.json", import.meta.url), "utf8"));
const receipts = normalizeReceipts(sample);

const decode = (canvas, bgWhite = false) => {
  let c = canvas;
  if (bgWhite) {
    c = createCanvas(canvas.width, canvas.height);
    const x = c.getContext("2d");
    x.fillStyle = "#fff";
    x.fillRect(0, 0, c.width, c.height);
    x.drawImage(canvas, 0, 0);
  }
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height);
  return jsQR(d.data, c.width, c.height)?.data ?? null;
};

test("accepts ca_receipt output and recomputes the archive's hash", () => {
  assert.equal(receipts.length, 4);
  for (const r of receipts) assert.equal(receiptHash(r), r.sha256, r.url);
  assert.equal(normalizeReceipts(sample.receipts[1]).length, 1);
  assert.equal(normalizeReceipts([{ nope: 1 }]).length, 0);
});

test("an edited quote is flagged on the receipt", () => {
  const L = layoutReceipt({ ...receipts[1], quote: "Internet 3.0 is coming." }, { asOf: "2026-10-26" });
  assert.equal(L.verified, false);
  assert.equal(layoutReceipt(receipts[1], { asOf: "2026-10-26" }).verified, true);
});

test("every receipt's QR scans to its original post", () => {
  for (const r of receipts) {
    const L = layoutReceipt(r, { asOf: "2026-10-26" });
    assert.equal(decode(renderReceipt(L, 1), true), r.url);
  }
});

test("layout has the anchors the video targets", () => {
  const L = layoutReceipt(receipts[2], { asOf: "2026-10-26" });
  for (const k of ["timestamp", "quote", "stamp", "qr"]) assert.ok(L.anchors[k]?.h > 0, k);
  assert.ok(L.anchors.timestamp.w <= RW);
  assert.ok(L.anchors.timestamp.y < L.anchors.quote.y && L.anchors.quote.y < L.anchors.qr.y);
});

test("sticker is transparent outside the die-cut and its QR scans", () => {
  const st = makeSticker(receipts[0], { asOf: "2026-10-26", k: 1.5 });
  const px = st.canvas.getContext("2d").getImageData(0, 0, 1, 1).data;
  assert.equal(px[3], 0);
  assert.equal(decode(st.canvas, true), receipts[0].url);
});

test("the scene draws at every phase without errors", () => {
  const scene = makeReceiptScene(receipts[1], { W: 540, H: 960, asOf: "2026-10-26" });
  const c = createCanvas(540, 960);
  const ctx = c.getContext("2d");
  for (let t = 0; t <= scene.duration; t += 0.25) scene.draw(ctx, t);
  assert.ok(scene.duration > 9 && scene.duration < 16);
});

let hasFfmpeg = true;
try {
  execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
  hasFfmpeg = false;
}
test("encodes a playable MP4", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rv-"));
  const out = path.join(dir, "t.mp4");
  const scene = makeReceiptScene(receipts[1], { W: 360, H: 640, asOf: "2026-10-26" });
  const short = { duration: 1, draw: (ctx, t) => scene.draw(ctx, t * 4) };
  await renderScene(short, createCanvas(360, 640), out, { fps: 10 });
  assert.ok(statSync(out).size > 1000);
});
