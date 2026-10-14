import { CARD_ROW, CYLINDER_RY, PIPE_RX, crossesRect, pathLength, runsAlong } from './layout.ts';
import type { EdgePath, Layout, NodeBox, Pt, Rect } from './layout.ts';

/** What a reader has to follow in one layout. Lengths are in pixels. */
export interface Metrics {
  /** Relationship lines drawn, self-relationships included. */
  lines: number;
  /** Relationships with no line, or a line that does not start on its source and end on its target: on the element, or on the symbol row it names. */
  broken: number;
  /** Total length of the lines. */
  length: number;
  /** Length beyond the shortest right-angled path between the two ends of each line, past the step round a box that any line may take. */
  detour: number;
  /** The longest line, as a multiple of the drawing's diagonal. */
  longest: number;
  /** Corners on all lines, and on the line with the most. Two corners join any two boxes. */
  bends: number;
  maxBends: number;
  /** Places where two lines cross. */
  crossings: number;
  /** Lines that pass through an element or a group that holds neither of their ends. */
  through: number;
  /** Lines that run through the name of a group. */
  titles: number;
  /** Lines that run through the label of another line, or through a status badge. */
  struck: number;
  /** Labels that lie on another label or on an element, and lines that run on top of one another. */
  overlaps: number;
  /** Group names wider than their group. */
  clipped: number;
  /** The line that goes furthest out of its way, when one does. */
  worst?: { from: string; to: string; length: number; direct: number };
}

/** What a drawing must do before it is worth judging. A layout that fails one is not kept while another passes them all. */
export const GATES = ['lines', 'text', 'overlap', 'width', 'height'] as const;
export type Gate = (typeof GATES)[number];

/** A line is a detour when it is this much longer than the direct path, in pixels and as a ratio. */
const DETOUR_PX = 300;
const DETOUR_RATIO = 3;
/** A line may be this much longer than the direct path at no cost: it is what one step round a box takes. */
const STEP = 60;

const overlap = (a: Rect, b: Rect, pad = 0): boolean =>
  a.x < b.x + b.w + pad && a.x + a.w > b.x - pad && a.y < b.y + b.h + pad && a.y + a.h > b.y - pad;

/** Counts the places where a flat segment of one line meets an upright segment of the other, away from their ends. */
function crossings(a: Pt[], b: Pt[]): number {
  let count = 0;
  for (let i = 1; i < a.length; i++) for (let j = 1; j < b.length; j++) {
    const p = a[i - 1]!, q = a[i]!, r = b[j - 1]!, s = b[j]!;
    const flatA = Math.abs(p.y - q.y) < 0.5, flatB = Math.abs(r.y - s.y) < 0.5;
    if (flatA === flatB) continue;
    const [h1, h2, v1, v2] = flatA ? [p, q, r, s] : [r, s, p, q];
    if (v1.x > Math.min(h1.x, h2.x) + 1 && v1.x < Math.max(h1.x, h2.x) - 1
      && h1.y > Math.min(v1.y, v2.y) + 1 && h1.y < Math.max(v1.y, v2.y) - 1) count++;
  }
  return count;
}

/**
 * True when the end of a line lies on the border of its element. On a file it lies on a side,
 * level with the row of the symbol the line names, or with the header when it names none.
 */
function attached(p: Pt, b: NodeBox, symbol: string | undefined): boolean {
  // The end of a line is moved onto the curved side of a cylinder or a pipe.
  const slack = 2 + (b.el.type === 'datastore' ? CYLINDER_RY : b.el.type === 'queue' ? PIPE_RX : 0);
  const inX = p.x >= b.x - slack && p.x <= b.x + b.w + slack, inY = p.y >= b.y - slack && p.y <= b.y + b.h + slack;
  const onSide = inY && (Math.abs(p.x - b.x) <= slack || Math.abs(p.x - (b.x + b.w)) <= slack);
  if (!b.card) return onSide || (inX && (Math.abs(p.y - b.y) <= slack || Math.abs(p.y - (b.y + b.h)) <= slack));
  const row = symbol === undefined ? undefined : b.card.rows[(b.el.symbols ?? []).findIndex((s) => s.name === symbol)];
  const [top, bottom] = row ? [b.y + row.dy - CARD_ROW / 2, b.y + row.dy + CARD_ROW / 2] : [b.y, b.y + b.card.head];
  return onSide && p.y >= top - 1 && p.y <= bottom + 1;
}

export function measure(l: Layout): Metrics {
  const box = new Map(l.nodes.map((b) => [b.el.id, b]));
  const holds = (group: NodeBox, id: string): boolean => {
    const seen = new Set<string>();
    for (let b = box.get(id); b && !seen.has(b.el.id); b = b.el.parent !== undefined ? box.get(b.el.parent) : undefined) {
      if (b === group) return true;
      seen.add(b.el.id);
    }
    return false;
  };
  const edges = l.edges.filter((e) => e.points.length > 1);
  const m: Metrics = { lines: edges.length, broken: l.edges.length - edges.length, length: 0, detour: 0, longest: 0, bends: 0, maxBends: 0, crossings: 0, through: 0, titles: 0, struck: 0, overlaps: 0, clipped: 0 };
  const diagonal = Math.hypot(l.width, l.height) || 1;
  let worst = 0;
  edges.forEach((e, i) => {
    const length = pathLength(e.points);
    const first = e.points[0]!, last = e.points.at(-1)!;
    const bends = e.points.length - 2;
    if (!attached(first, box.get(e.rel.from)!, e.rel.fromSymbol) || !attached(last, box.get(e.rel.to)!, e.rel.toSymbol)) m.broken++;
    m.length += length;
    m.longest = Math.max(m.longest, length / diagonal);
    if (e.rel.from !== e.rel.to) {
      const direct = Math.abs(first.x - last.x) + Math.abs(first.y - last.y);
      m.detour += Math.max(0, length - direct - STEP);
      m.bends += bends;
      m.maxBends = Math.max(m.maxBends, bends);
      // Three times the direct path, or a line longer than the drawing is wide and tall that goes well out of its way.
      if (length - direct > Math.max(worst, DETOUR_PX) && (length > direct * DETOUR_RATIO || (length > diagonal * 1.2 && length > direct * 1.5))) {
        worst = length - direct;
        m.worst = { from: e.rel.from, to: e.rel.to, length: Math.round(length), direct: Math.round(direct) };
      }
    }
    for (const other of edges.slice(i + 1)) m.crossings += crossings(e.points, other.points);
    if (l.nodes.some((b) => b.el.id !== e.rel.from && b.el.id !== e.rel.to
      && !(b.group && (holds(b, e.rel.from) || holds(b, e.rel.to))) && crossesRect(e.points, b, -1.5))) m.through++;
  });
  const labelled = edges.filter((e): e is EdgePath & { label: Rect } => e.label !== undefined);
  labelled.forEach((e, i) => {
    if (labelled.slice(i + 1).some((o) => overlap(e.label, o.label, -1)) || l.nodes.some((b) => !b.group && overlap(e.label, b, -1))) m.overlaps++;
    if (edges.some((o) => o !== e && crossesRect(o.points, e.label, -2))) m.struck++;
  });
  // A line drawn on top of another reads as one line. Lines that share an end may share the stretch next to it.
  edges.forEach((e, i) => {
    for (const o of edges.slice(i + 1)) {
      const loop = e.rel.from === e.rel.to || o.rel.from === o.rel.to;
      const shared = e.rel.from === o.rel.from || e.rel.to === o.rel.to || e.rel.from === o.rel.to || e.rel.to === o.rel.from;
      if ((loop || !shared) && runsAlong(e.points, o.points, 3, 14)) m.overlaps++;
    }
  });
  for (const b of l.nodes) {
    if (b.title) {
      m.titles += edges.filter((e) => crossesRect(e.points, b.title!, 1)).length;
      if (b.title.x < b.x - 0.5 || b.title.x + b.title.w + (b.badge ? b.badge.x + b.badge.w - b.title.x - b.title.w : 0) > b.x + b.w + 0.5) m.clipped++;
    }
    if (b.badge) m.struck += edges.filter((e) => crossesRect(e.points, b.badge!, 1)).length;
  }
  m.length = Math.round(m.length);
  m.detour = Math.round(m.detour);
  m.longest = Math.round(m.longest * 100) / 100;
  return m;
}

/** The gates a layout fails, worst first. The size is that of the whole image. */
export function failed(m: Metrics, size: { width: number; height: number }, max: { width: number; height: number }): Gate[] {
  const out: Gate[] = [];
  if (m.broken > 0) out.push('lines');
  if (m.through + m.titles + m.struck > 0) out.push('text');
  if (m.overlaps + m.clipped > 0) out.push('overlap');
  if (size.width > max.width) out.push('width');
  if (size.height > max.height) out.push('height');
  return out;
}

/** The wide-to-tall shape a drawing is nudged toward when nothing else tells two layouts apart. */
export const GOLDEN = 1.6;

/**
 * What a reader feels in a layout that passes the gates, most important first: crossings, lines that
 * go out of their way, corners past the two that join any two boxes, then how far the whole image is
 * from the golden shape. Compared in that order, so a better shape never buys a crossing.
 */
export const rank = (m: Metrics, width: number, height: number): number[] =>
  [m.crossings, Math.round(m.detour / 150), Math.ceil(Math.max(0, m.bends - 2 * m.lines) / 4), Math.round(Math.abs(Math.log(width / Math.max(1, height) / GOLDEN)) * 10)];

/** Negative when `a` reads better than `b`. */
export const compare = (a: number[], b: number[]): number => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
};

/**
 * What a reader would find wrong with a layout. Each line states the fault and no more:
 * the fixes are tried by `advise`, and only one that works is printed.
 */
export function faults(m: Metrics, name: (id: string) => string): string[] {
  const out: string[] = [];
  const n = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;
  if (m.broken > 0) out.push(`${n(m.broken, 'relationship is', 'relationships are')} not drawn from end to end`);
  if (m.worst) out.push(`the line from "${name(m.worst.from)}" to "${name(m.worst.to)}" runs ${m.worst.length}px where ${m.worst.direct}px would join them`);
  if (m.through > 0) out.push(`${n(m.through, 'line passes', 'lines pass')} through a box that is not theirs`);
  if (m.titles > 0) out.push(`${n(m.titles, 'line runs', 'lines run')} through the name of a group`);
  if (m.struck > 0) out.push(`${n(m.struck, 'line runs', 'lines run')} through a label or a badge`);
  if (m.overlaps > 0) out.push(`${n(m.overlaps, 'place', 'places')} where a label lies on a label or a box, or one line lies on another`);
  if (m.clipped > 0) out.push(`${n(m.clipped, 'group is', 'groups are')} narrower than ${m.clipped === 1 ? 'its' : 'their'} name`);
  if (m.crossings >= 3) out.push(`${m.crossings} line crossings on ${m.lines} lines`);
  return out;
}
