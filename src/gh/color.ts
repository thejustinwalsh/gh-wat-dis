// Label colours come from OKLCH so they share one lightness and differ only in hue.
// GitHub stores a label colour as six hex digits and picks the text colour itself.

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const toSrgb = (x: number): number => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);

function oklchToLinear(l: number, c: number, h: number): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180), b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

/** An OKLCH colour as six hex digits. Chroma is reduced until the colour fits sRGB, so the hue and lightness hold. */
export function oklchHex(l: number, c: number, h: number): string {
  let rgb = oklchToLinear(l, c, h);
  for (let chroma = c; chroma > 0 && rgb.some((v) => v < -0.0005 || v > 1.0005); chroma -= 0.005) rgb = oklchToLinear(l, chroma, h);
  return rgb.map((v) => Math.round(clamp01(toSrgb(clamp01(v))) * 255).toString(16).padStart(2, '0')).join('');
}

const GOLDEN_ANGLE = 137.508;
const SURFACE = { l: 0.78, c: 0.1, start: 200 };

/**
 * The colour of the nth surface label. Each hue sits a golden angle from the last, so neighbours in the
 * list look different, and a label keeps its colour when another is added after it.
 */
export const surfaceColor = (index: number): string => oklchHex(SURFACE.l, SURFACE.c, (SURFACE.start + index * GOLDEN_ANGLE) % 360);

/** Type and agents labels are more saturated than surfaces, and keep the meaning their hue has in a diff or an editor. */
export const ROLE_COLORS = {
  bug: oklchHex(0.66, 0.2, 27),
  feature: oklchHex(0.74, 0.17, 145),
  task: oklchHex(0.78, 0.12, 232),
  agents: oklchHex(0.72, 0.16, 300),
  otherType: oklchHex(0.8, 0.02, 270),
};
