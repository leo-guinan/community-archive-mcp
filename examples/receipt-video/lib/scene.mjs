// The printed-receipt shot: the receipt feeds out of a slot, the camera follows, then pushes in on
// the timestamp while a marker sweeps over it, pulls back for the PROOF stamp, and pushes in on the QR.
import { createCanvas } from "@napi-rs/canvas";
import { font, registerFonts } from "./fonts.mjs";
import { layoutReceipt, renderReceipt, renderStamp, drawHighlight, RW, MARKER } from "./receipt.mjs";
import { clamp, easeInOut, easeOut, easeOutBack, lerp, span } from "./ease.mjs";

export const FORMATS = {
  "9x16": [1080, 1920],
  "16x9": [1920, 1080],
  "1x1": [1080, 1080],
  "4x5": [1080, 1350],
};

export function drawBackground(ctx, W, H, bg) {
  if (bg === "green") return (ctx.fillStyle = "#00b140"), ctx.fillRect(0, 0, W, H);
  if (bg === "black") return (ctx.fillStyle = "#000"), ctx.fillRect(0, 0, W, H);
  if (bg === "white") return (ctx.fillStyle = "#eceae4"), ctx.fillRect(0, 0, W, H);
  const g = ctx.createRadialGradient(W / 2, H * 0.32, 0, W / 2, H * 0.45, Math.max(W, H) * 0.8);
  g.addColorStop(0, "#272c48");
  g.addColorStop(1, "#11131d");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

export function pill(ctx, text, cx, y, ui, { accent = MARKER, alpha = 1, align = "center", size = 30 } = {}) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ui = (ui * size) / 30;
  ctx.font = font.sans(700, Math.round(30 * ui));
  const tw = ctx.measureText(text).width;
  const ph = 66 * ui, pw = tw + 86 * ui;
  const x = align === "right" ? cx - pw : cx - pw / 2;
  ctx.fillStyle = "rgba(14,16,26,0.92)";
  ctx.beginPath();
  ctx.roundRect(x, y, pw, ph, ph / 2);
  ctx.fill();
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(x + 32 * ui, y + ph / 2, 9 * ui, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.fillText(text, x + 58 * ui, y + ph / 2 + 11 * ui);
  ctx.restore();
}

export function makeReceiptScene(receipt, { W = 1080, H = 1920, asOf, bg = "ink", captions = true, footer = "Receipt from the Community Archive", k } = {}) {
  registerFonts();
  const L = layoutReceipt(receipt, { asOf });
  const b0 = Math.min(W * 0.8, H * 0.6) / RW;
  const K = k ?? Math.min(3, Math.max(2, b0 * 1.7)); // enough resolution for the push-ins
  const paper = renderReceipt(L, K);
  const stamp = renderStamp(L, 2);
  const ui = Math.min(W, H) / 1080;
  const shadows = bg !== "green";
  const bgCanvas = createCanvas(W, H);
  if (bg) drawBackground(bgCanvas.getContext("2d"), W, H, bg);

  const ts = L.anchors.timestamp, qr = L.anchors.qr, q = L.anchors.quote;
  const fitS = Math.min(b0, (H * 0.86) / L.height, (W * 0.9) / RW);
  const cams = {
    fit: { s: fitS, cy: L.height / 2 },
    ts: { s: Math.min((W * 0.92) / (ts.w + 70), b0 * 1.7), cy: ts.y + ts.h / 2 },
    qr: { s: Math.min(b0 * 1.45, (H * 0.42) / qr.h), cy: qr.y + qr.h / 2 },
  };
  const sa = L.anchors.stamp;
  const stampAt = { x: RW / 2 + 40, y: sa.y + sa.h / 2 + 8, rot: -0.12, scale: 0.78 };

  // Timeline (seconds)
  const T = {};
  T.slot = 0.35;
  T.print = clamp(L.height / 520, 2.2, 3.4);
  T.cut = T.slot + T.print;
  T.toTs = T.cut + 0.35;
  T.sweep = T.toTs + 0.75;
  T.toFit = T.sweep + 0.55 + 1.3;
  T.stamp = T.toFit + 0.8;
  T.toQr = T.stamp + 1.5;
  T.toEnd = T.toQr + 0.75 + 1.4;
  T.end = T.toEnd + 0.75 + 1.1;
  const duration = T.end;

  const follow = (t) => {
    const s = b0;
    const p = printed(t);
    return { s, cy: Math.max((0.36 * H) / s, p - (0.3 * H) / s) };
  };
  const printed = (t) => {
    const u = span(t, T.slot, T.cut);
    return Math.floor((u * L.height) / 5) * 5; // advance in printer rows
  };
  const mix = (a, b, u) => ({ s: lerp(a.s, b.s, u), cy: lerp(a.cy, b.cy, u) });
  const camera = (t) => {
    if (t < T.toTs) return follow(t);
    const legs = [
      [T.toTs, 0.75, follow(T.toTs), cams.ts],
      [T.toFit, 0.75, cams.ts, cams.fit],
      [T.toQr, 0.75, cams.fit, cams.qr],
      [T.toEnd, 0.75, cams.qr, cams.fit],
    ];
    let cam = follow(T.toTs);
    for (const [start, len, a, b] of legs) if (t >= start) cam = mix(a, b, easeInOut(span(t, start, start + len)));
    return cam;
  };
  const shake = (t) => {
    const hits = [[T.cut, 0.18, 4], [T.stamp + 0.24, 0.2, 9]];
    let dx = 0, dy = 0;
    for (const [at, len, amp] of hits)
      if (t >= at && t < at + len) {
        const f = 1 - (t - at) / len;
        dx += Math.sin(t * 97) * amp * f;
        dy += Math.cos(t * 83) * amp * f;
      }
    return [dx * ui, dy * ui];
  };

  function draw(ctx, t) {
    if (bg) ctx.drawImage(bgCanvas, 0, 0);
    const { s, cy } = camera(t);
    const [dx, dy] = shake(t);
    const X = (x) => W / 2 + (x - RW / 2) * s + dx;
    const Y = (y) => H / 2 + (y - cy) * s + dy;
    const p = t >= T.cut ? L.height : printed(t);

    // paper
    if (p > 0) {
      ctx.save();
      if (shadows) {
        ctx.shadowColor = "rgba(0,0,0,0.45)";
        ctx.shadowBlur = 40 * s;
        ctx.shadowOffsetY = 18 * s;
      }
      ctx.drawImage(paper, 0, 0, paper.width, Math.min(paper.height, p * K), X(0), Y(0), RW * s, p * s);
      ctx.restore();
      const hl = easeOut(span(t, T.sweep, T.sweep + 0.55));
      if (hl > 0) {
        ctx.save();
        ctx.setTransform(s, 0, 0, s, X(0), Y(0));
        drawHighlight(ctx, L, hl);
        ctx.restore();
      }
    }

    // stamp
    if (t >= T.stamp) {
      const u = span(t, T.stamp, T.stamp + 0.28);
      const sc = lerp(2.3, 1, easeOutBack(u)) * stampAt.scale;
      ctx.save();
      ctx.globalAlpha = clamp(u * 3) * 0.9;
      ctx.globalCompositeOperation = bg === "green" ? "source-over" : "multiply";
      ctx.translate(X(stampAt.x), Y(stampAt.y));
      ctx.rotate(stampAt.rot);
      const w = (stamp.width / 2) * sc * s, h = (stamp.height / 2) * sc * s;
      ctx.drawImage(stamp, -w / 2, -h / 2, w, h);
      ctx.restore();
    }

    // slot (drawn over the paper so the paper comes out from under it)
    const slotY = Y(-6);
    if (slotY > -100) {
      const a = easeOut(span(t, 0, T.slot));
      ctx.save();
      ctx.globalAlpha = a;
      const sw = (RW + 110) * s, sh = 46 * s;
      ctx.fillStyle = "#07080d";
      ctx.beginPath();
      ctx.roundRect(X(RW / 2) - sw / 2, slotY - sh + 8 * s, sw, sh, sh / 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.fillRect(X(RW / 2) - sw / 2 + sh / 2, slotY - sh + 10 * s, sw - sh, 3 * s);
      ctx.restore();
    }

    // scanner sweep over the QR while the camera is on it
    const scanU = span(t, T.toQr + 0.7, T.toQr + 2.1);
    if (scanU > 0 && scanU < 1) {
      const qx = X(qr.x), qy = Y(qr.y), qs = qr.w * s;
      const ly = qy + qs * (0.5 - 0.5 * Math.cos(scanU * Math.PI * 4));
      ctx.save();
      ctx.strokeStyle = "#2fd39a";
      ctx.lineWidth = 5 * ui;
      const c = qs * 0.16, o = 10 * ui;
      for (const [cx, cy, sx, sy] of [[qx - o, qy - o, 1, 1], [qx + qs + o, qy - o, -1, 1], [qx - o, qy + qs + o, 1, -1], [qx + qs + o, qy + qs + o, -1, -1]]) {
        ctx.beginPath();
        ctx.moveTo(cx, cy + sy * c);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx + sx * c, cy);
        ctx.stroke();
      }
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = "#2fd39a";
      ctx.shadowColor = "#2fd39a";
      ctx.shadowBlur = 18 * ui;
      ctx.fillRect(qx - o, ly - 2 * ui, qs + 2 * o, 4 * ui);
      ctx.restore();
    }

    if (captions) {
      // label sits in the empty right side of the POSTED row, above the highlighted line
      const a1 = span(t, T.sweep + 0.3, T.sweep + 0.6) * (1 - span(t, T.toFit, T.toFit + 0.3));
      const rowH = 34 * s, ph = 66 * ui * (22 / 30);
      pill(ctx, "TIMESTAMP FROM THE ARCHIVE", X(RW - 56), Y(ts.y) - rowH + (rowH - ph) / 2 - 4 * s, ui, { alpha: a1, align: "right", size: 22 });
      const a3 = span(t, T.toEnd + 0.6, T.toEnd + 0.95);
      if (footer && a3 > 0) {
        ctx.save();
        ctx.globalAlpha = a3;
        ctx.font = font.sans(600, Math.round(30 * ui));
        ctx.fillStyle = bg === "white" ? "#1d1f2b" : "rgba(255,255,255,0.85)";
        const fw = ctx.measureText(footer).width;
        ctx.fillText(footer, W / 2 - fw / 2, H - 60 * ui);
        ctx.restore();
      }
    }
  }

  return { duration, draw, L, T, cams };
}
