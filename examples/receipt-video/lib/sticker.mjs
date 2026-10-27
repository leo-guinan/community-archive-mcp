// A die-cut sticker of the receipt: torn top and bottom, white border that follows the paper,
// transparent everywhere else (sticker printers cut along the edge of the transparency).
import { createCanvas } from "@napi-rs/canvas";
import { layoutReceipt, renderReceipt, renderStamp, paperPath, RW } from "./receipt.mjs";
import { font } from "./fonts.mjs";

export function makeSticker(receipt, { asOf, k = 3, border = 34 } = {}) {
  const L = layoutReceipt(receipt, { asOf, topTear: true });
  const paper = renderReceipt(L, k, { highlight: 1 });
  const stamp = renderStamp(L, k);
  const m = border + 6;
  const c = createCanvas(Math.ceil((RW + 2 * m) * k), Math.ceil((L.height + 2 * m) * k));
  const ctx = c.getContext("2d");
  ctx.scale(k, k);
  ctx.translate(m, m);
  // white die-cut border
  paperPath(ctx, L);
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = border * 2;
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.fill();
  ctx.drawImage(paper, 0, 0, RW, L.height);
  // stamp, inked onto the paper
  const sa = L.anchors.stamp;
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.globalCompositeOperation = "multiply";
  ctx.translate(RW / 2 + 40, sa.y + sa.h / 2 + 8);
  ctx.rotate(-0.12);
  const w = 430 * 0.78, h = 210 * 0.78;
  ctx.drawImage(stamp, -w / 2, -h / 2, w, h);
  ctx.restore();
  return { canvas: c, L, inches: { w: c.width / 300, h: c.height / 300 } };
}

/** A social-ready preview: the sticker slapped on a dark laptop lid. */
export function stickerPreview(sticker, { W = 1080, H = 1350, caption = "Receipt sticker" } = {}) {
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#3a3e48");
  g.addColorStop(1, "#22252c");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(255,255,255,0.03)";
  for (let i = 0; i < 260; i++) ctx.fillRect((i * 97) % W, (i * 211) % H, 2, 2);
  const s = Math.min((W * 0.62) / sticker.canvas.width, (H * 0.8) / sticker.canvas.height);
  ctx.save();
  ctx.translate(W / 2, H * 0.47);
  ctx.rotate(-0.07);
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 10;
  const w = sticker.canvas.width * s, h = sticker.canvas.height * s;
  ctx.drawImage(sticker.canvas, -w / 2, -h / 2, w, h);
  ctx.restore();
  if (caption) {
    ctx.font = font.sans(600, 30);
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    const tw = ctx.measureText(caption).width;
    ctx.fillText(caption, W / 2 - tw / 2, H - 56);
  }
  return c;
}
