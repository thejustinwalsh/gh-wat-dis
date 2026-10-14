// Advance widths in 1/1000 em for ASCII 32..126 (Helvetica/Arial metrics).
// The other fonts in the stack are within a few percent, which PAD covers.
const ASCII = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const PAD = 1.08;
const BOLD = 1.07;

function advance(ch: string): number {
  const code = ch.codePointAt(0)!;
  if (code >= 32 && code < 127) return ASCII[code - 32]!;
  if (code >= 0x2e80) return 1000;
  if (code === 0x2212 || code === 0xd7) return 584;
  if (code >= 0x2010 && code <= 0x2027) return code === 0x2014 || code === 0x2026 ? 1000 : 556;
  return code >= 0x2190 && code <= 0x21ff ? 1000 : 600;
}

export function textWidth(text: string, px: number, bold = false): number {
  let units = 0;
  for (const ch of text) units += advance(ch);
  return (units / 1000) * px * PAD * (bold ? BOLD : 1);
}

function breakWord(word: string, px: number, max: number, bold: boolean): string[] {
  // A long name breaks after a hyphen, a slash, a dot or an underscore, where a reader sees a seam. Only a piece
  // with no seam that is still too wide is cut between letters.
  const pieces = word.match(/[^-/._:]+[-/._:]*|[-/._:]+/g) ?? [word];
  const parts: string[] = [];
  let part = '';
  for (const piece of pieces) {
    if (part && textWidth(part + piece, px, bold) > max) { parts.push(part); part = ''; }
    if (textWidth(piece, px, bold) <= max) { part += piece; continue; }
    for (const ch of piece) {
      if (part && textWidth(part + ch, px, bold) > max) { parts.push(part); part = ch; } else part += ch;
    }
  }
  if (part) parts.push(part);
  return parts;
}

/** Width in a monospace font: every character advances 0.6 em. */
export const monoWidth = (text: string, px: number): number => [...text].length * 0.602 * px * PAD;

/** Greedy word wrap. A word wider than `max` is split by character. */
export function wrap(text: string, px: number, max: number, bold = false): string[] {
  const lines: string[] = [];
  let line = '';
  for (const raw of text.trim().split(/\s+/).filter(Boolean)) {
    const pieces = textWidth(raw, px, bold) > max ? breakWord(raw, px, max, bold) : [raw];
    for (const word of pieces) {
      const next = line ? `${line} ${word}` : word;
      if (line && textWidth(next, px, bold) > max) { lines.push(line); line = word; } else line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Wrap onto as few lines as `wrap` needs, with the lines as even as they can be, so the last line is not one word left alone.
 */
export function wrapEven(text: string, px: number, max: number, bold = false): string[] {
  const lines = wrap(text, px, max, bold);
  if (lines.length < 2) return lines;
  let lo = 0, hi = max;
  while (hi - lo > 2) { const mid = (lo + hi) / 2; if (wrap(text, px, mid, bold).length === lines.length) hi = mid; else lo = mid; }
  return wrap(text, px, hi, bold);
}

/** Cut `text` to `max` pixels, ending in an ellipsis when it does not fit. */
export function fit(text: string, px: number, max: number, bold = false): string {
  if (textWidth(text, px, bold) <= max) return text;
  const chars = [...text];
  while (chars.length > 1 && textWidth(chars.join('') + '\u2026', px, bold) > max) chars.pop();
  return chars.join('').trimEnd() + '\u2026';
}

export const escapeXml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
    // Control characters are not legal in XML 1.0.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
