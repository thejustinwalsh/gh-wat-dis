// A PNG of a drawing, so an agent can look at a diagram it made. resvg is an npm dependency with a
// prebuilt binary for each platform, so this works wherever the package installs.

import { Resvg } from '@resvg/resvg-js';

/**
 * Draw an SVG string as PNG bytes at twice its size, so small labels stay readable.
 * resvg reads no CSS variables and no media queries: pass an SVG with a fixed theme, not the `auto` one.
 * Text uses the fonts of this machine, with Helvetica or Arial standing in for the system UI font.
 */
export function toPng(svg: string): { png: Uint8Array; width: number; height: number } {
  const image = new Resvg(svg, {
    font: { loadSystemFonts: true, defaultFontFamily: 'Helvetica', sansSerifFamily: 'Arial' },
    fitTo: { mode: 'zoom', value: 2 },
  }).render();
  return { png: image.asPng(), width: image.width, height: image.height };
}
