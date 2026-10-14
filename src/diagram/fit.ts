import type { DiagramSpec, LabelMode } from '../spec.ts';
import { GATES, GOLDEN, compare, failed, faults, measure, rank } from './judge.ts';
import type { Gate, Metrics } from './judge.ts';
import { isCompact, layout } from './layout.ts';
import type { Layout, LayoutOptions } from './layout.ts';

/** GitHub draws an issue or PR body about 860px wide. A wider image is scaled down and its text shrinks. */
export const MAX_WIDTH = 860;
const CHROME_W = 48;
/** Title, scope line and a one-row key, for a caller that does not pass the real frame. */
const CHROME_H = 176;
/** Past this height the image does not fit a screen, and gets a warning. It is the height of the whole image. */
export const TALL = 900;
/** The shapes a wrapped layout aims for, as width to height: the golden one first, then narrower. */
const WRAPS = [GOLDEN, 1, 0.6] as const;

export interface FitOptions extends LayoutOptions {
  labels?: LabelMode;
  maxWidth?: number;
  /** The size of the whole image for a layout: title, scope line and key included. The renderer passes it. */
  frame?: (l: Layout) => { width: number; height: number };
}

type Direction = 'DOWN' | 'RIGHT';
/**
 * The form each type of diagram is drawn in. It is a rule, not a score. A code diagram runs left to
 * right, the only way a line can end on a symbol row. The others may run either way: top down is
 * tried first, and a flow left to right first.
 */
const formsOf = (type: DiagramSpec['type']): Direction[][] => (type === 'code' ? [['RIGHT'], ['DOWN']] : type === 'dynamic' ? [['RIGHT', 'DOWN']] : [['DOWN', 'RIGHT']]);

/** One layout that was tried, with what a reader has to follow in it. */
export interface Candidate extends Metrics {
  /** The rung of the ladder it was tried on, from 1. */
  rung: number;
  direction: Direction;
  labels: 'text' | 'numbered';
  compact: boolean;
  wrapped: boolean;
  /** Size of the whole image, title and key included: the numbers the size line prints. */
  width: number;
  height: number;
  /** The gates it fails. Empty when it passes them all. */
  fails: Gate[];
  chosen: boolean;
}

/** The judgement on a drawing: what was chosen, why, and what is still wrong with it. */
export interface Report {
  /** One sentence on the choice. */
  why: string;
  /** The rung the chosen layout is on, and how many rungs this spec has. */
  rung: number;
  rungs: number;
  /** False when no layout passes every gate. The layout nearest to passing is drawn, with a warning for each gate it fails. */
  passed: boolean;
  /** Faults of the chosen layout. Empty when it reads well. */
  warnings: string[];
  candidates: Candidate[];
}

const way = (d: Direction): string => (d === 'RIGHT' ? 'left to right' : 'top down');
const GATE_WORDS: Record<Gate, string> = {
  lines: 'cannot draw every line from end to end',
  text: 'puts a line through text',
  overlap: 'puts a label or a line on top of another',
  width: 'is too wide',
  height: 'is too tall',
};

/** What one rung of the ladder gives up, next to the spec as written. */
interface Step { direction: Direction; numbered: boolean; compact: boolean; wrap?: number }

/**
 * Draws the spec the way its type is drawn, and loosens that form one step at a time until a
 * layout passes every gate: each relationship drawn from end to end, no line through text, nothing
 * on top of anything else, and the whole image within the page width.
 *
 * The ladder is fixed. Rung 1 is the spec as written. Then, in the order of what a reader loses:
 * numbers on the lines or a long chain wrapped onto rows, then both, then the same three with
 * compact cards. A step the spec or the caller rules out is not on the ladder. The first rung
 * with a layout that passes is the answer, and between layouts on that rung the one a reader
 * follows most easily wins: fewest crossings, then least detour, then fewest corners, then the
 * shape nearest the golden one.
 *
 * A direction, a label mode or a level of detail named in the spec or in `opts` is never overridden.
 * When no rung passes, the layout nearest to passing is returned and `passed` is false.
 */
export async function judge(spec: DiagramSpec, opts: FitOptions = {}): Promise<{ layout: Layout; report: Report }> {
  const maxWidth = opts.maxWidth ?? MAX_WIDTH;
  const named = opts.direction ?? (spec.direction === 'RIGHT' || spec.direction === 'DOWN' ? spec.direction : undefined);
  const forms = named ? [[named]] : formsOf(spec.type);
  const mode = opts.labels ?? spec.labels ?? 'auto';
  // Lines with no words have nothing to number.
  const worded = spec.relationships.some((r) => r.label?.trim());
  const numberings = mode === 'auto' ? (worded ? [false, true] : [false]) : [mode === 'numbered'];
  const asked = opts.detail ?? spec.detail ?? 'auto';
  // File cards have one form, and a spec with many elements is compact already.
  const details = asked === 'auto' && !isCompact(spec, 'auto') && spec.elements.some((e) => e.type !== 'file' && e.type !== 'boundary') ? [false, true] : [asked === 'compact'];

  const ladder: { name: string; steps: Step[] }[] = [];
  for (const compact of details) for (const given of [0, 1, 2]) for (const directions of forms) {
    const steps: Step[] = [];
    for (const numbered of numberings) for (const wrap of [undefined, ...WRAPS]) for (const direction of directions) {
      if (Number(numbered !== numberings[0]) + Number(wrap !== undefined) === given) steps.push({ direction, numbered, compact, ...(wrap ? { wrap } : {}) });
    }
    if (!steps.length) continue;
    const gives = [...new Set(steps.flatMap((s) => [...(s.numbered !== numberings[0] ? ['numbers on the lines'] : []), ...(s.wrap ? ['wrapped'] : [])]))].join(given === 2 ? ' and ' : ' or ');
    const name = [...(forms.length > 1 ? [directions[0] === 'RIGHT' ? 'left to right' : 'files in a column'] : []), ...(compact && details.length > 1 ? ['compact cards'] : []), ...(gives ? [gives] : [])].join(', ');
    ladder.push({ name: name || 'as written', steps });
  }

  const tried: { layout: Layout; c: Candidate; order: number[] }[] = [];
  let failure: unknown;
  let best: (typeof tried)[number] | undefined;
  for (const [k, rung] of ladder.entries()) {
    for (const step of rung.steps) {
      const { direction } = step;
      let l: Layout;
      try { l = await layout(spec, { detail: step.compact ? 'compact' : asked, direction, numbered: step.numbered, wrap: step.wrap }); } catch (err) { failure ??= err; continue; }
      const m = measure(l);
      // A wrap that cut nothing, or a second shape that packs the same, repeats a layout already tried.
      if (tried.some((o) => o.c.direction === direction && o.layout.numbered === l.numbered && o.layout.compact === l.compact && o.layout.width === l.width && o.layout.height === l.height && o.c.length === m.length)) continue;
      const whole = opts.frame?.(l) ?? { width: l.width + CHROME_W, height: l.height + CHROME_H };
      const width = Math.ceil(whole.width), height = Math.ceil(whole.height);
      tried.push({ layout: l, order: rank(m, width, height), c: { rung: k + 1, direction, labels: l.numbered ? 'numbered' : 'text', compact: l.compact, wrapped: l.wrapped, width, height, fails: failed(m, { width, height }, { width: maxWidth, height: Math.round(maxWidth * GOLDEN) }), chosen: false, ...m } });
    }
    best = tried.filter((t) => t.c.rung === k + 1 && !t.c.fails.length).sort((a, b) => compare(a.order, b.order))[0];
    if (best) break;
  }
  // When no layout could be made, the reason is the layout engine's own error, not a guess.
  if (!tried.length) throw new Error(`could not lay out the diagram: ${failure instanceof Error ? failure.message : String(failure ?? 'no layout was tried')}`);
  const passed = best !== undefined;
  // No rung passes: the layout that fails the least is drawn. A missing line is worse than a line through text, and so on down the gates.
  const badness = (c: Candidate): number[] => [...GATES.slice(0, 3).map((g) => Number(c.fails.includes(g))), Math.ceil(Math.max(0, c.width - maxWidth) / 100), Math.ceil(Math.max(0, c.height - maxWidth * GOLDEN) / 100)];
  best ??= [...tried].sort((a, b) => compare(badness(a.c), badness(b.c)) || compare(a.order, b.order))[0]!;
  best.c.chosen = true;

  const c = best.c;
  const kept = [way(c.direction), ...(c.labels === 'numbered' ? ['numbers on the lines'] : worded ? ['words on the lines'] : []),
    ...(c.compact && details.length > 1 ? ['compact cards'] : []), ...(c.wrapped ? [c.direction === 'RIGHT' ? 'wrapped onto rows' : 'wrapped onto columns'] : [])];
  // Each rung above the one kept, with the gate its nearest layout fails.
  const lost: string[] = [];
  for (const [k, rung] of ladder.entries()) {
    if (k + 1 >= c.rung && passed) break;
    const near = tried.filter((t) => t.c.rung === k + 1).sort((a, b) => compare(badness(a.c), badness(b.c)))[0]?.c;
    if (!near || near === c) continue;
    const gate = near.fails[0];
    lost.push(`rung ${k + 1} (${rung.name}) ${gate === 'width' ? `is ${near.width}px wide` : gate === 'height' ? `is ${near.height}px tall` : gate ? GATE_WORDS[gate] : 'passes'}`);
  }
  const why = passed
    ? `kept ${kept.join(', ')}: rung ${c.rung} of ${ladder.length}${lost.length ? `. ${lost.join('; ')}` : ''}`
    : `no layout passes every check on any of the ${ladder.length} ${ladder.length === 1 ? 'rung' : 'rungs'}. Drew the nearest: ${kept.join(', ')}`;

  const name = new Map(spec.elements.map((e) => [e.id, e.name]));
  const warnings = faults(c, (id) => name.get(id) ?? id);
  if (c.height > TALL) warnings.unshift(`the image is ${c.height}px tall, so a reader scrolls to follow a line`);
  if (c.width > maxWidth) warnings.unshift(`${c.width}px is wider than GitHub's ${maxWidth}px body, so text will shrink`);
  return { layout: best.layout, report: { why, rung: c.rung, rungs: ladder.length, passed, warnings, candidates: tried.map((t) => t.c) } };
}

/** The layout `judge` keeps, without its report. */
export const fit = async (spec: DiagramSpec, opts: FitOptions = {}): Promise<Layout> => (await judge(spec, opts)).layout;
