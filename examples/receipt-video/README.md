# Receipt video and sticker generator

An example built on the Community Archive connector. Ask Claude for a receipt (`ca_receipt`), hand the result to this script, and get:

- **An MP4** of a thermal receipt printing out. The camera pushes in on the post's timestamp while a marker sweeps over it, a PROOF stamp lands, and a scanner passes over the QR code. 9:16, 16:9, 1:1 or 4:5, on a dark, green-screen, black or white background.
- **A die-cut sticker PNG**: the receipt with a white border and a transparent background, ready for a sticker printer, plus a preview image.

Every receipt carries a QR code that opens the original post. Each receipt also re-checks the archive's hash: `sha256(kind|date|url|quote)` must equal the `sha256` from `ca_receipt`. If anyone edits the quote, the receipt prints **EDITED SINCE ARCHIVE ✗** instead of **MATCHES COMMUNITY ARCHIVE ✓**.

## Setup

Needs Node 20+ and `ffmpeg` on your PATH (or `FFMPEG_PATH`). Fonts are bundled.

```bash
cd examples/receipt-video
npm install
```

## Get receipts

In Claude, with the connector added (`https://<host>/mcp`), ask something like:

> Find my first tweet that says "internet 2.0" and give me a receipt for it.

Claude calls `ca_first_said`, then `ca_receipt`. Save what `ca_receipt` returns as `receipts.json`. It looks like [`samples/leo-receipts.json`](samples/leo-receipts.json):

```json
{ "receipts": [ { "kind": "tweet", "date": "2025-06-16", "created_at": "2025-06-16T11:18:51.000Z",
  "handle": "@leo_guinan", "quote": "Internet 2.0 is coming.", "url": "https://x.com/leo_guinan/status/1934571367145275513",
  "sha256": "bb1440…", "provenance": { "request_id": "…", "fetched_at": "…" } } ] }
```

Or skip Claude and fetch directly with your own key, after `npm install && npm run build` in the repository root:

```bash
CA_API_KEY=cak_... node render.mjs --tweet https://x.com/leo_guinan/status/1934571367145275513 --sticker
```

## Render

```bash
node render.mjs receipts.json                    # one 9:16 MP4 per receipt, in ./out
node render.mjs receipts.json --sticker          # plus sticker-<id>.png and sticker-<id>-preview.png
node render.mjs receipts.json --format 16x9      # for YouTube cut-ins
node render.mjs receipts.json --bg green --no-captions   # for keying over other footage
pbpaste | node render.mjs -                      # JSON straight from the clipboard
```

| Option | Default | |
| --- | --- | --- |
| `--format` | `9x16` | `9x16` 1080×1920, `16x9` 1920×1080, `1x1`, `4x5` |
| `--bg` | `ink` | `ink`, `green`, `black`, `white` |
| `--index N` | all | Only the Nth receipt |
| `--sticker` | off | Also write the sticker PNG and preview |
| `--no-video` | off | Stickers only |
| `--as-of` | fetch time | Date used for "on record" and "days" |
| `--no-captions` | off | Hide the on-screen labels |
| `--fps`, `--crf` | 30, 18 | Encoding |

A receipt video runs 12 to 13 seconds and takes about 20 seconds to render on two cores.

### Timeline of a receipt video

| Seconds (approx.) | What happens |
| --- | --- |
| 0 – 3.3 | Paper feeds out of the slot, line by line; the camera follows the print head |
| 3.3 | Cut: torn edge, small shake |
| 3.7 – 6.3 | Push in on the timestamp; marker sweep; "TIMESTAMP FROM THE ARCHIVE" label |
| 6.3 – 8.6 | Pull back; PROOF stamp with the post date slams into the stamp box |
| 8.6 – 10.7 | Push in on the QR; scanner brackets and sweep |
| 10.7 – end | Whole receipt, footer line |

The exact times come from `makeReceiptScene(...).T`, so music can be cut to them.

## Demo video

```bash
node demo.mjs                       # out/demo.mp4, 29 s, 1080×1920
node demo.mjs receipts.json --index 0 --query "build in public" --matches 132
```

The demo shows a request being typed, the connector tools running (`ca_first_said`, `ca_receipt`), the returned receipt JSON with its timestamp highlighted, the receipt printing, the sticker, and an end card. It's graphics only, so it works under a voiceover or music.

## Stickers

`sticker-<id>.png` is 2520 px wide with a transparent background. Most sticker printers (Sticker Mule, Stickerapp and others) cut along the edge of the transparency, which here is the white border around the torn paper. That's enough resolution for a sticker up to about 8 inches tall. The QR on the sticker opens the post.

## Using it from code

```js
import { normalizeReceipts } from "./lib/receipt.mjs";
import { makeReceiptScene } from "./lib/scene.mjs";
import { renderScene } from "./lib/encode.mjs";
import { makeSticker } from "./lib/sticker.mjs";
import { createCanvas } from "@napi-rs/canvas";

const [r] = normalizeReceipts(json);
const scene = makeReceiptScene(r, { W: 1080, H: 1920 });   // { duration, draw(ctx, t), T }
await renderScene(scene, createCanvas(1080, 1920), "receipt.mp4");
writeFileSync("sticker.png", makeSticker(r).canvas.toBuffer("image/png"));
```

## Tests

```bash
npm test   # hash check, QR decodes to the post URL, sticker transparency, scene draws, MP4 encodes
```
