// A PNG of a drawing, so an agent can look at a diagram it made. resvg is an npm dependency with a
// prebuilt binary for each platform, so this works wherever the package installs.

import { Resvg } from '@resvg/resvg-js';
import { FONT } from '../diagram/theme.ts';

const FONTS = { loadSystemFonts: true, defaultFontFamily: 'Helvetica', sansSerifFamily: 'Arial' };

/**
 * Draw an SVG string as PNG bytes at twice its size, so small labels stay readable.
 * resvg reads no CSS variables and no media queries: pass an SVG with a fixed theme, not the `auto` one.
 * Text uses the fonts of this machine, with Helvetica or Arial standing in for the system UI font.
 */
/** Emoji and the joiners that glue them. resvg has no colour font: one emoji turns its whole line of text into boxes. */
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}][\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\p{Extended_Pictographic}]*/gu;

/**
 * `emoji` counts the emoji that were drawn as a small box. The SVG still holds them: only the PNG cannot draw them.
 */
export function toPng(svg: string): { png: Uint8Array; width: number; height: number; emoji: number } {
  let emoji = 0;
  svg = svg.replace(/>([^<]+)</g, (_, text: string) => `>${text.replace(EMOJI, () => { emoji++; return '\u25A1'; })}<`);
  const image = new Resvg(svg, { font: FONTS, fitTo: { mode: 'zoom', value: 2 } }).render();
  return { png: image.asPng(), width: image.width, height: image.height, emoji };
}

/**
 * Whether the rasterizer draws text on this machine. resvg reports no error when it finds no font
 * for a label: it leaves the label out, and the PNG holds boxes and lines with no words.
 * This draws one word in the diagram's font on a transparent canvas and looks for a pixel.
 */
export function drawsText(): boolean {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="24"><text x="2" y="18" font-size="16" style="font-family:${FONT.replace(/"/g, "'")}">Sample</text></svg>`;
  const { pixels } = new Resvg(svg, { font: FONTS }).render();
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) return true;
  return false;
}
