// Bundled fonts (from @fontsource), registered once under short family names.
import { GlobalFonts } from "@napi-rs/canvas";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const filesOf = (pkg) => path.join(path.dirname(require.resolve(`${pkg}/package.json`)), "files");

let registered = false;
export function registerFonts() {
  if (registered) return;
  registered = true;
  const reg = (pkg, file, alias) => GlobalFonts.registerFromPath(path.join(filesOf(pkg), file), alias);
  for (const w of [400, 500, 700]) {
    reg("@fontsource/ibm-plex-mono", `ibm-plex-mono-latin-${w}-normal.woff2`, `Mono${w}`);
    reg("@fontsource/ibm-plex-mono", `ibm-plex-mono-latin-ext-${w}-normal.woff2`, `Mono${w}x`);
  }
  for (const w of [400, 500, 600, 700]) reg("@fontsource/hanken-grotesk", `hanken-grotesk-latin-${w}-normal.woff2`, `Sans${w}`);
  reg("@fontsource/big-shoulders-stencil-display", "big-shoulders-stencil-display-latin-800-normal.woff2", "Stencil");
}

// Fallbacks cover characters outside the bundled subsets (CJK, symbols) with whatever the system has.
const FALLBACK = `"DejaVu Sans Mono", "Noto Sans Mono", "Menlo", "Noto Sans CJK SC", "Apple Color Emoji", "Noto Color Emoji", monospace`;
export const font = {
  mono: (w, px) => `${px}px Mono${w}, Mono${w}x, ${FALLBACK}`,
  sans: (w, px) => `${px}px Sans${w}, "Helvetica Neue", Arial, "DejaVu Sans", "Noto Sans CJK SC", sans-serif`,
  stencil: (px) => `${px}px Stencil, Impact, "Arial Narrow", sans-serif`,
};
