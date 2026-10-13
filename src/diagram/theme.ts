export type ThemeName = 'auto' | 'light' | 'dark';

export const FONT = '-apple-system, "Segoe UI", Helvetica, Arial, sans-serif';
/** For symbol names. */
export const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

/** One colour per role. Text roles are checked against every fill for WCAG AA in test/diagram.test.ts. */
export interface Palette {
  bg: string;
  frame: string;
  fg: string;
  muted: string;
  line: string;
  stroke: string;
  person: string;
  system: string;
  container: string;
  component: string;
  store: string;
  external: string;
  group: string;
  added: string;
  changed: string;
  removed: string;
  affected: string;
  onStatus: string;
}

export const LIGHT: Palette = {
  bg: '#ffffff',
  frame: '#d1d9e0',
  fg: '#1f2328',
  muted: '#57606a',
  line: '#57606a',
  stroke: '#7d8894',
  person: '#e9e5fb',
  system: '#d3e5fb',
  container: '#e2eefc',
  component: '#f0f6fd',
  store: '#dbf1f0',
  external: '#eaeef2',
  group: '#f6f8fa',
  added: '#1a7f37',
  changed: '#9a6700',
  removed: '#cf222e',
  affected: '#0969da',
  onStatus: '#ffffff',
};

export const DARK: Palette = {
  bg: '#0d1117',
  frame: '#3d444d',
  fg: '#f0f6fc',
  muted: '#a9b4c0',
  line: '#a9b4c0',
  stroke: '#7a8696',
  person: '#2b2652',
  system: '#17325c',
  container: '#172a47',
  component: '#161f30',
  store: '#12323a',
  external: '#272d36',
  group: '#12171e',
  added: '#3fb950',
  changed: '#d29922',
  removed: '#f85149',
  affected: '#58a6ff',
  onStatus: '#0d1117',
};

/** Fills that carry text, by palette key. */
export const FILLS = ['bg', 'person', 'system', 'container', 'component', 'store', 'external', 'group'] as const;
export const STATUS_COLOURS = ['added', 'changed', 'removed', 'affected'] as const;

const kebab = (k: string): string => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
const vars = (p: Palette): string => Object.entries(p).map(([k, v]) => `--${kebab(k)}:${v}`).join(';');

/**
 * `auto` keeps `var()` references and adds a dark media block.
 * `light` and `dark` inline the literal colours, so renderers without custom-property support still work.
 */
export function applyTheme(css: string, theme: ThemeName): string {
  if (theme === 'auto') {
    return `:root{${vars(LIGHT)}}@media (prefers-color-scheme:dark){:root{${vars(DARK)}}}${css}`;
  }
  const palette = (theme === 'dark' ? DARK : LIGHT) as unknown as Record<string, string>;
  return css.replace(/var\(--([a-z-]+)\)/g, (_, name: string) =>
    palette[name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] ?? '#000');
}

const channel = (v: number): number => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
