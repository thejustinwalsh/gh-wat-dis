import type { DiagramSpec, LabelMode } from '../spec.ts';
import { layout } from './layout.ts';
import type { Layout, LayoutOptions } from './layout.ts';

/** GitHub draws an issue or PR body about 860px wide. A wider image is scaled down and its text shrinks. */
export const MAX_WIDTH = 860;
const CHROME_W = 48;

export interface FitOptions extends LayoutOptions { labels?: LabelMode; maxWidth?: number }

/** A numbered diagram needs a table beside it, so it must save this much height to be chosen. */
const NUMBERED_COST = 150;
const WRAPS = [undefined, 2, 1.2] as const;

/**
 * Lays the spec out every way the caller left open (direction, words or numbers on the lines,
 * wrapping a long chain onto a second row) and keeps the shortest one that fits the page width.
 * A flow (`dynamic`) is already numbered, so numbers cost it nothing.
 */
export async function fit(spec: DiagramSpec, opts: FitOptions = {}): Promise<Layout> {
  const maxWidth = opts.maxWidth ?? MAX_WIDTH;
  const directions = opts.direction ? [opts.direction] : spec.direction ? [spec.direction] : ['DOWN', 'RIGHT'] as const;
  const mode = opts.labels ?? spec.labels ?? 'auto';
  const numberings = mode === 'auto' ? [false, true] : [mode === 'numbered'];
  const numberedCost = spec.type === 'dynamic' ? 0 : NUMBERED_COST;
  let best: { layout: Layout; score: number } | undefined;
  for (const numbered of numberings) {
    for (const direction of directions) {
      for (const wrap of WRAPS) {
        let l: Layout;
        try { l = await layout(spec, { detail: opts.detail, direction, numbered, wrap }); } catch { continue; }
        const score = l.height + Math.max(0, l.width + CHROME_W - maxWidth) * 3 + (numbered ? numberedCost : 0) + (wrap ? 20 : 0);
        if (!best || score < best.score) best = { layout: l, score };
      }
    }
  }
  if (!best) throw new Error('could not lay out the diagram');
  return best.layout;
}
