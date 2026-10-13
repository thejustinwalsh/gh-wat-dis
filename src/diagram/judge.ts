import { crossesRect, pathLength } from './layout.ts';
import type { EdgePath, Layout, NodeBox, Pt, Rect } from './layout.ts';

/** What a reader has to follow in one layout. Lengths are in pixels. */
export interface Metrics {
  /** Relationship lines drawn, self-relationships included. */
  lines: number;
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
  /** Labels that lie on another label, on an element, or on another line. */
  overlaps: number;
  /** The line that goes furthest out of its way, when one does. */
  worst?: { from: string; to: string; length: number; direct: number };
}

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
  const m: Metrics = { lines: edges.length, length: 0, detour: 0, longest: 0, bends: 0, maxBends: 0, crossings: 0, through: 0, overlaps: 0 };
  const diagonal = Math.hypot(l.width, l.height) || 1;
  let worst = 0;
  edges.forEach((e, i) => {
    const length = pathLength(e.points);
    const first = e.points[0]!, last = e.points.at(-1)!;
    const bends = e.points.length - 2;
    m.length += length;
    m.longest = Math.max(m.longest, length / diagonal);
    if (e.rel.from !== e.rel.to) {
      const direct = Math.abs(first.x - last.x) + Math.abs(first.y - last.y);
      m.detour += Math.max(0, length - direct - STEP);
      m.bends += bends;
      m.maxBends = Math.max(m.maxBends, bends);
      if (length - direct > Math.max(worst, DETOUR_PX) && length > direct * DETOUR_RATIO) {
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
    const hit = labelled.slice(i + 1).some((o) => overlap(e.label, o.label, -1))
      || l.nodes.some((b) => !b.group && overlap(e.label, b, -1))
      || edges.some((o) => o !== e && crossesRect(o.points, e.label, -2));
    if (hit) m.overlaps++;
  });
  m.length = Math.round(m.length);
  m.detour = Math.round(m.detour);
  m.longest = Math.round(m.longest * 100) / 100;
  return m;
}

/**
 * How much harder the lines make a layout to read, in the same unit as its height in pixels.
 * A pixel of detour costs more than a pixel of height: a tall calm drawing beats a short tangled one.
 */
export const lineCost = (m: Metrics): number =>
  m.detour * 0.6 + Math.max(0, m.bends - 2 * m.lines) * 12 + m.crossings * 24 + m.through * 300 + m.overlaps * 200;

/** What is wrong with a layout, with the filter that mends it. Empty when the layout reads well. */
export function faults(m: Metrics, name: (id: string) => string): string[] {
  const out: string[] = [];
  if (m.worst) {
    out.push(`the line from "${name(m.worst.from)}" to "${name(m.worst.to)}" runs ${m.worst.length}px where ${m.worst.direct}px would join them. `
      + 'Fold a group into one box with "graph collapse", or split the diagram in two.');
  }
  if (m.through > 0) out.push(`${m.through} ${m.through === 1 ? 'line passes' : 'lines pass'} through a box that is not theirs. Cut the diagram down with "graph focus".`);
  if (m.crossings > Math.max(3, m.lines / 2)) {
    out.push(`${m.crossings} line crossings on ${m.lines} lines. Keep what the change touches with "graph focus", or drop the lines that did not change with "graph diff".`);
  }
  if (m.overlaps > 0) out.push(`${m.overlaps} ${m.overlaps === 1 ? 'label lies' : 'labels lie'} on a line or a box. Draw numbers on the lines with --labels numbered.`);
  return out;
}
