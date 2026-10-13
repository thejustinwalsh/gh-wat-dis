import type { Detail, DiagramSpec, LabelMode } from '../spec.ts';
import { faults, lineCost, measure } from './judge.ts';
import type { Metrics } from './judge.ts';
import { layout } from './layout.ts';
import type { Layout, LayoutOptions } from './layout.ts';

/** GitHub draws an issue or PR body about 860px wide. A wider image is scaled down and its text shrinks. */
export const MAX_WIDTH = 860;
const CHROME_W = 48;

export interface FitOptions extends LayoutOptions { labels?: LabelMode; maxWidth?: number }

/**
 * What each way of making a drawing smaller costs, in pixels of height it must save to be chosen.
 * The order is what the reader loses. The other direction loses only the author's wish. Rows lose
 * the single reading line. Numbers send the reader to a table. Compact cards lose the descriptions.
 * Width past the page costs most, by the pixel: GitHub scales the image down and all the text shrinks.
 */
const TURNED_COST = 40;
const WRAP_COST = 60;
/**
 * A numbered diagram needs a table beside it. A flow (`dynamic`) is numbered anyway, so numbers cost it nothing.
 * Words on lines add a little line cost that numbers do not, so this is set where the examples keep the
 * labels they had when the score was height alone and numbers cost 150.
 */
const NUMBERED_COST = 200;
/** A code diagram that names each file's group above its card loses the band that holds a group together. */
const FLAT_COST = 70;
const FLAT_REPEAT_COST = 25;
/** Top down, a line ends on the file, not on the symbol row it concerns. */
const OFF_ROW_COST = 160;
const COMPACT_COST = 250;
const WIDE_COST = 5;
/** A few pixels over shrink the text by a hair. Past that, a layout that fits is worth this much more. */
const WIDE_SLACK = 20;
const WIDE_AT_ALL = 80;
/** Past this height a drawing does not fit a screen, and gets a warning. */
export const TALL = 900;
const WRAPS = [undefined, 2, 1.2] as const;

/** One layout that was tried, with what a reader has to follow in it. */
export interface Candidate extends Metrics {
  direction: 'DOWN' | 'RIGHT';
  labels: 'text' | 'numbered';
  compact: boolean;
  wrapped: boolean;
  /** Groups of a code diagram named above each card, not drawn as bands. */
  flat: boolean;
  /** Size of the drawing without the title and the key. `width` includes the side margins. */
  width: number;
  height: number;
  /** Relationships this layout fails to draw as the spec states them. A layout with any is never kept while another has none. */
  broken: number;
  /** Lower is better: height, plus what the lines and each shortcut cost. */
  score: number;
  chosen: boolean;
}

/** The judgement on a drawing: what was chosen, why, and what is still wrong with it. */
export interface Report {
  /** One sentence on the choice. */
  why: string;
  /** Faults of the chosen layout, each with the filter that mends it. Empty when it reads well. */
  warnings: string[];
  candidates: Candidate[];
}

const way = (d: 'DOWN' | 'RIGHT'): string => (d === 'RIGHT' ? 'left to right' : 'top down');

/** The main thing wrong with a layout that lost, next to the one that won. */
function flaw(c: Candidate, best: Candidate, maxWidth: number): string {
  if (c.width > maxWidth && c.width > best.width) return `is ${c.width}px wide`;
  if (c.worst || c.detour > best.detour + 200) return 'sends lines the long way round';
  if (c.crossings > best.crossings) return `has ${c.crossings - best.crossings} more line crossings`;
  if (c.overlaps > best.overlaps || c.through > best.through) return 'puts lines over boxes or labels';
  return `is ${Math.max(1, Math.round(c.height - best.height))}px taller`;
}

/**
 * Lays the spec out every way the caller left open (direction, words or numbers on the lines,
 * full or compact cards, a long chain on one row or two) and keeps the one that reads best:
 * the shortest drawing, after the cost of its lines and of each shortcut it took.
 * A direction in the spec is a wish, so the other one is tried too. A direction in `opts` is an order.
 * A flow (`dynamic`) is already numbered, so numbers cost it nothing.
 */
export async function judge(spec: DiagramSpec, opts: FitOptions = {}): Promise<{ layout: Layout; report: Report }> {
  const maxWidth = opts.maxWidth ?? MAX_WIDTH;
  const wish = spec.direction === 'RIGHT' || spec.direction === 'DOWN' ? spec.direction : undefined;
  const directions = opts.direction ? [opts.direction] : wish ? [wish, wish === 'RIGHT' ? 'DOWN' : 'RIGHT'] as const : ['DOWN', 'RIGHT'] as const;
  const mode = opts.labels ?? spec.labels ?? 'auto';
  // Lines with no words have nothing to number.
  const worded = spec.relationships.some((r) => r.label?.trim());
  const numberings = mode === 'auto' ? (worded ? [false, true] : [false]) : [mode === 'numbered'];
  const numberedCost = spec.type === 'dynamic' ? 0 : NUMBERED_COST;
  const asked = opts.detail ?? spec.detail ?? 'auto';
  // File cards have one form, so a code diagram has no compact one.
  const details: Detail[] = asked === 'auto' && spec.elements.some((e) => e.type !== 'file' && e.type !== 'boundary') ? ['auto', 'compact'] : [asked];
  let compactAnyway = false;
  const rows = spec.relationships.some((r) => r.fromSymbol !== undefined || r.toSymbol !== undefined);
  const tried: { layout: Layout; c: Candidate }[] = [];
  for (const numbered of numberings) {
    for (const direction of directions) {
      for (const detail of details) {
        // A spec with many elements is compact without being asked.
        if (detail === 'compact' && compactAnyway) continue;
        for (const wrap of WRAPS) {
          for (const flat of spec.type === 'code' ? [false, true] : [false]) {
            // When a line runs through the name of a group, the same layout is tried again with the group widened to clear it.
            for (const clearTitles of [false, true]) {
              let l: Layout;
              try { l = await layout(spec, { detail, direction, numbered, wrap, flat, clearTitles }); } catch { break; }
              // A wrap that cut nothing, or an option that changed nothing, repeats a layout already tried.
              if ((wrap && !l.wrapped) || flat !== l.flat) break;
              if (detail === 'auto' && l.compact) compactAnyway = true;
              const m = measure(l);
              const width = Math.ceil(l.width + CHROME_W), height = Math.ceil(l.height);
              // The flat form repeats the name of a group above each of its cards.
              const repeats = l.flat ? l.nodes.filter((b) => b.card?.lane).length - new Set(l.nodes.map((b) => b.card?.lane).filter(Boolean)).size : 0;
              const shortcuts = (numbered ? numberedCost : 0) + (l.flat ? FLAT_COST + repeats * FLAT_REPEAT_COST : 0) + (rows && direction === 'DOWN' ? OFF_ROW_COST : 0)
                + (l.wrapped ? WRAP_COST : 0) + (detail === 'compact' && asked === 'auto' ? COMPACT_COST : 0) + (wish && !opts.direction && direction !== wish ? TURNED_COST : 0);
              const over = Math.max(0, width - maxWidth);
              const score = Math.round(height + over * WIDE_COST + (over > WIDE_SLACK ? WIDE_AT_ALL : 0) + lineCost(m) + shortcuts);
              // Two option sets that give one drawing are one candidate.
              const twin = tried.some((o) => o.c.width === width && o.c.height === height && o.c.direction === direction && o.layout.numbered === numbered && o.c.length === m.length && o.c.compact === l.compact && o.c.flat === l.flat);
              if (!twin) tried.push({ layout: l, c: { direction, labels: numbered ? 'numbered' : 'text', compact: l.compact, wrapped: l.wrapped, flat: l.flat, width, height, broken: l.broken, score, chosen: false, ...m } });
              if (m.titles === 0 || flat) break;
            }
          }
        }
      }
    }
  }
  // A layout that drops a line or leaves one hanging is wrong, however small it is. It is kept only when every layout is.
  const whole = tried.some((t) => t.c.broken === 0);
  const best = tried.filter((t) => !whole || t.c.broken === 0).reduce<(typeof tried)[number] | undefined>((a, b) => (!a || b.c.score < a.c.score ? b : a), undefined);
  if (!best) throw new Error('could not lay out the diagram');
  best.c.chosen = true;

  const c = best.c;
  const kept = [way(c.direction), ...(c.labels === 'numbered' ? ['numbers on the lines'] : worded ? ['words on the lines'] : []),
    ...(c.flat ? ['group names above the cards'] : []), ...(c.compact && asked === 'auto' && tried.some((t) => !t.c.compact) ? ['compact cards'] : []), ...(c.wrapped ? [c.direction === 'RIGHT' ? 'wrapped onto rows' : 'wrapped onto columns'] : [])];
  // For each shortcut taken, the best layout without it says why it lost.
  const without = (test: (o: Candidate) => boolean): Candidate | undefined =>
    tried.map((t) => t.c).filter((o) => o.broken === 0).filter(test).sort((a, b) => a.score - b.score)[0];
  const lost: string[] = [];
  const say = (what: string, o: Candidate | undefined): void => { if (o) lost.push(`${what} ${flaw(o, c, maxWidth)}`); };
  if (wish && c.direction !== wish) say(way(wish), without((o) => o.direction === wish));
  if (c.labels === 'numbered' && numberings.length > 1 && spec.type !== 'dynamic') say('words on the lines', without((o) => o.labels === 'text' && o.direction === c.direction));
  if (c.flat) say('a band round each group', without((o) => !o.flat && o.direction === c.direction));
  if (kept.includes('compact cards')) say('full cards', without((o) => !o.compact && o.direction === c.direction && o.labels === c.labels));
  if (c.wrapped) say(c.direction === 'RIGHT' ? 'one row' : 'one column', without((o) => !o.wrapped && o.direction === c.direction && o.labels === c.labels));
  const why = `kept ${kept.join(', ')}, the best of ${tried.length} layouts${lost.length ? `: ${lost.join('; ')}` : ''}`;

  const name = new Map(spec.elements.map((e) => [e.id, e.name]));
  const warnings = faults(c, (id) => name.get(id) ?? id);
  if (c.broken > 0) warnings.unshift(`${c.broken} of the ${spec.relationships.length} relationships could not be drawn from end to end in any layout`);
  if (c.height > TALL) warnings.unshift(`the drawing is ${c.height}px tall, so a reader scrolls to follow a line`);
  if (c.width > maxWidth) warnings.unshift(`${c.width}px is wider than GitHub's ${maxWidth}px body, so text will shrink`);
  return { layout: best.layout, report: { why, warnings, candidates: tried.map((t) => t.c) } };
}

/** The layout `judge` keeps, without its report. */
export const fit = async (spec: DiagramSpec, opts: FitOptions = {}): Promise<Layout> => (await judge(spec, opts)).layout;
