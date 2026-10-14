import ELK from 'elkjs/lib/elk.bundled.js';
import type { Detail, DiagramSpec, SpecElement, SpecRelationship } from '../spec.ts';
import { codeShape } from './code-shape.ts';
import { fit, monoWidth, textWidth, wrap, wrapEven } from './measure.ts';
import { STATUS_BADGE, STATUS_MARK, active, kindLine } from './vocab.ts';
import type { ActiveStatus } from './vocab.ts';

export interface Pt { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }
export interface TextLine { text: string; cls: string; dy: number }
/** One symbol of a file card. `dy` is the middle of its row, from the top of the card. */
export interface CardRow { name: string; kind?: string; status?: ActiveStatus; dy: number }
/** A file drawn as a card: the path in the header, then a row for each symbol, then a note. */
export interface FileCard {
  dir: string; base: string; rows: CardRow[]; note?: { text: string; dy: number };
  /** Height of the header. A long path puts its folders on a small line above the file name, and the header is taller. */
  head: number;
  stacked: boolean;
  /** The name of the group the file is in, small and in capitals at the top of the card. */
  lane?: string;
}
/** The name of a group, where the layout engine kept room for it. `stacked` puts the kind under the name. */
export interface GroupTitle extends Rect { name: string; kind: string; stacked: boolean }
export interface NodeBox {
  el: SpecElement;
  group: boolean;
  depth: number;
  x: number; y: number; w: number; h: number;
  lines: TextLine[];
  /** Where the status badge is drawn: inside a leaf, and at the end of the title of a group. */
  badge?: Rect;
  /** Set on a group. The layout engine places it as it places a box, so no line is routed through it. */
  title?: GroupTitle;
  /** Set on a `file`. Its status is a mark in the header, so it has no badge. */
  card?: FileCard;
  /** A group in a code diagram: a tinted band with a small name, no border. */
  light?: boolean;
}
export interface EdgeLabel extends Rect { lines: TextLine[] }
export interface EdgePath { rel: SpecRelationship; points: Pt[]; label?: EdgeLabel }
export interface Layout {
  width: number; height: number; nodes: NodeBox[]; edges: EdgePath[];
  direction: 'DOWN' | 'RIGHT'; numbered: boolean; compact: boolean;
  /** True when a long chain was cut and continued on a second row or column. */
  wrapped: boolean;
}
export interface LayoutOptions {
  detail?: Detail;
  direction?: 'DOWN' | 'RIGHT';
  numbered?: boolean;
  /** Target width / height. When set, ELK may cut a long chain and continue it on the next row or column. */
  wrap?: number;
}

/** The number drawn on a relationship in numbered mode: its `order`, else its position in the spec. */
export const relNumber = (spec: DiagramSpec, rel: SpecRelationship): number => rel.order ?? spec.relationships.indexOf(rel) + 1;

export const NODE_W = 208;
const NODE_W_FLOW = 176;
export const CYLINDER_RY = 8;
export const PIPE_RX = 11;
export const GROUP_NAME_PX = 13;
export const GROUP_KIND_PX = 10.5;
export const BADGE_PX = 9.5;
export const BADGE_H = 16;
const BADGE_GAP = 10;
/** A group title wider than this puts the kind under the name. */
const TITLE_MAX = 300;
/** Unconnected parts are packed toward this shape, a little wider than tall. */
const PACK_ASPECT = 1.6;
const PAD_X = 14;
export const CARD_HEAD = 30;
export const CARD_HEAD_STACKED = 42;
export const CARD_DIR_PX = 10.5;
/** A path wider than this goes on two lines. */
const CARD_PATH_MAX = 190;
export const CARD_ROW = 20;
export const CARD_PAD = 12;
/** Where a symbol name starts, after its status mark. */
export const CARD_NAME_X = 27;
export const CARD_PATH_PX = 12;
export const CARD_SYMBOL_PX = 11.5;
export const CARD_KIND_PX = 10;
export const LANE_NAME_PX = 10.5;
const CARD_MIN = 148;
const CARD_MAX = 240;
/** The widest a card may be when a code diagram has one, two or three layers: three columns and the room for their lines fill the page. */
const CARD_WIDEST = 360;
/** Room a code diagram leaves for the gap between two layers, its lines and their turns, when it shares the page out among its cards. */
const LAYER_GAP = 96;
const PAGE = 812;
/** Room at the top of a card for the name of its group. */
export const CARD_LANE = 14;
export const CARD_ROWS_MAX = 8;
/** Lines that end on one row or header sit this far apart, or closer when there are many. */
const PORT_GAP = 6;
const LABEL_MAX = 170;
const FULL_DETAIL_MAX = 5;
const TOP_INSET: Record<string, number> = { person: 40, datastore: 2 * CYLINDER_RY + 8 };

export const badgeWidth = (status: string): number => Math.ceil(textWidth(STATUS_BADGE[status] ?? '', BADGE_PX, true) + 14);

/** The badge sits inside the top right corner of a leaf: under the lid of a cylinder, left of the face of a pipe. */
const BADGE_TOP: Record<string, number> = { datastore: 2 * CYLINDER_RY + 5 };
const BADGE_RIGHT: Record<string, number> = { datastore: 8, queue: 2 * PIPE_RX + 3, person: 7 };
const badgeTop = (type: string): number => BADGE_TOP[type] ?? 5;

function leafBadge(b: NodeBox): Rect | undefined {
  const status = active(b.el.status);
  if (!status || b.card) return undefined;
  const w = badgeWidth(status);
  return { x: b.x + b.w - (BADGE_RIGHT[b.el.type] ?? 6) - w, y: b.y + badgeTop(b.el.type), w, h: BADGE_H };
}

/** True when the polyline comes within `pad` of the rectangle. Segments are axis aligned, so their bounds are exact. */
export function crossesRect(points: Pt[], r: Rect, pad = 0): boolean {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    if (Math.max(a.x, b.x) > r.x - pad && Math.min(a.x, b.x) < r.x + r.w + pad
      && Math.max(a.y, b.y) > r.y - pad && Math.min(a.y, b.y) < r.y + r.h + pad) return true;
  }
  return false;
}

function leafText(el: SpecElement, compact: boolean, width: number): { h: number; lines: TextLine[] } {
  const inner = width - 2 * PAD_X - (el.type === 'queue' ? 2 * PIPE_RX : 0);
  const lines: TextLine[] = [];
  let y = TOP_INSET[el.type] ?? (compact ? 11 : 14);
  // The name starts under the badge, so a long name never runs into it.
  if (active(el.status)) y = Math.max(y, badgeTop(el.type) + BADGE_H - 1);
  const add = (texts: string[], cls: string, lineHeight: number, ascent: number): void => {
    for (const text of texts) { lines.push({ text, cls, dy: y + ascent }); y += lineHeight; }
  };
  add(wrap(el.name, 14, inner, true), 'nm', 18, 13.5);
  y += 1;
  add(wrap(kindLine(el), 11, inner), 'ty', 14, 10.5);
  if (el.description && !compact) { y += 6; add(wrap(el.description, 12, inner), 'ds', 16, 11.5); }
  return { h: Math.ceil(y + (el.type === 'datastore' ? CYLINDER_RY + 8 : compact ? 10 : 13)), lines };
}

/**
 * Cut a name that does not fit. A qualified name loses its leading parts whole (`…Sprite.addEffect`), so the part
 * that names the symbol stays. Any other name is cut in the middle: names in one file often share a start and differ at the end.
 */
const monoFit = (text: string, px: number, max: number): string => {
  const chars = [...text];
  if (monoWidth(text, px) <= max) return text;
  const seams = [...text.matchAll(/(::|\.)/g)].map((m) => m.index! + m[0].length);
  for (const at of seams) if (monoWidth(`\u2026${text.slice(at)}`, px) <= max) return `\u2026${text.slice(at)}`;
  let keep = chars.length - 1;
  const cut = (n: number): string => `${chars.slice(0, Math.ceil(n * 0.6)).join('')}\u2026${chars.slice(chars.length - Math.floor(n * 0.4)).join('')}`;
  while (keep > 2 && monoWidth(cut(keep), px) > max) keep--;
  return cut(keep);
};

/** True when the path of a file is too wide for one line of a card header. */
const longPath = (el: SpecElement): boolean => {
  const cut = el.name.lastIndexOf('/') + 1;
  return el.type === 'file' && textWidth(el.name.slice(0, cut), CARD_PATH_PX) + textWidth(el.name.slice(cut), CARD_PATH_PX, true) + 15 > CARD_PATH_MAX;
};

/** A file card is as wide as its longest line, within limits. A long path loses its leading folders first. */
function fileCard(el: SpecElement, stack: boolean, widest = CARD_MAX, group?: string): { w: number; h: number; card: FileCard } {
  const mark = active(el.status) ? 15 : 0;
  const cut = el.name.lastIndexOf('/') + 1;
  let dir = el.name.slice(0, cut);
  const stacked = stack && dir !== '';
  const lane = group === undefined ? undefined : fit(group.toUpperCase(), LANE_NAME_PX, (widest - 2 * CARD_PAD) / 1.06, true);
  const head = (stacked ? CARD_HEAD_STACKED : CARD_HEAD) + (lane === undefined ? 0 : CARD_LANE);
  const dirPx = stacked ? CARD_DIR_PX : CARD_PATH_PX;
  const room = widest - 2 * CARD_PAD - mark;
  const pathWidth = (d: string, b: string): number =>
    (stacked ? Math.max(textWidth(d, dirPx), textWidth(b, CARD_PATH_PX, true)) : textWidth(d, dirPx) + textWidth(b, CARD_PATH_PX, true));
  while (dir && (stacked ? textWidth(dir, dirPx) : pathWidth(dir, el.name.slice(cut))) > room) {
    const rest = dir.replace(/^\u2026\//, '');
    const next = rest.indexOf('/');
    dir = next < 0 || next === rest.length - 1 ? '' : `\u2026/${rest.slice(next + 1)}`;
  }
  const base = fit(el.name.slice(cut), CARD_PATH_PX, room - (stacked ? 0 : textWidth(dir, dirPx)), true);
  const symbols = (el.symbols ?? []).slice(0, CARD_ROWS_MAX);
  const kindWidth = (kind: string | undefined): number => (kind ? textWidth(kind, CARD_KIND_PX) + 12 : 0);
  const rowWidth = Math.max(0, ...symbols.map((s) => CARD_NAME_X + monoWidth(s.name, CARD_SYMBOL_PX) + kindWidth(s.kind) + CARD_PAD));
  const note = el.description?.trim();
  const w = Math.ceil(Math.min(widest, Math.max(CARD_MIN, pathWidth(dir, base) + mark + 2 * CARD_PAD, rowWidth, note ? textWidth(note, 11) + 2 * CARD_PAD : 0, lane === undefined ? 0 : laneLabelWidth(lane) + 2 * CARD_PAD)));
  const rows: CardRow[] = symbols.map((s, i) => ({
    name: monoFit(s.name, CARD_SYMBOL_PX, w - CARD_NAME_X - kindWidth(s.kind) - CARD_PAD),
    ...(s.kind ? { kind: s.kind } : {}), ...(active(s.status) ? { status: active(s.status)! } : {}),
    dy: head + 4 + i * CARD_ROW + CARD_ROW / 2,
  }));
  let h = head + (rows.length ? rows.length * CARD_ROW + 9 : 0);
  const card: FileCard = { dir, base, rows, head, stacked, ...(lane === undefined ? {} : { lane }) };
  if (note) { card.note = { text: fit(note, 11, w - 2 * CARD_PAD), dy: h + (rows.length ? 9 : 12) }; h += rows.length ? 18 : 22; }
  return { w, h, card };
}

function edgeLabel(rel: SpecRelationship, num?: number): { w: number; h: number; lines: TextLine[] } {
  if (num === undefined && !rel.label?.trim()) return { w: 0, h: 0, lines: [] };
  if (num !== undefined) {
    const text = String(num);
    return { w: Math.ceil(Math.max(20, textWidth(text, 11, true) + 12)), h: 20, lines: [{ text, cls: 'en', dy: 14 }] };
  }
  const status = active(rel.status);
  const text = `${status ? `${STATUS_MARK[status]} ` : ''}${rel.order !== undefined ? `${rel.order}. ` : ''}${rel.label}`;
  const lines: TextLine[] = [];
  let y = 3, w = 0;
  for (const line of wrapEven(text, 11.5, LABEL_MAX)) {
    lines.push({ text: line, cls: 'el', dy: y + 11 });
    w = Math.max(w, textWidth(line, 11.5, true));
    y += 14.5;
  }
  if (rel.technology) for (const line of wrap(`[${rel.technology}]`, 10, LABEL_MAX)) {
    lines.push({ text: line, cls: 'et', dy: y + 9.5 });
    w = Math.max(w, textWidth(line, 10));
    y += 12.5;
  }
  return { w: Math.ceil(w + 12), h: Math.ceil(y + 3), lines };
}

/** Width of a group's name and kind on one line. */
export const groupLabelWidth = (el: SpecElement): number =>
  textWidth(el.name, GROUP_NAME_PX, true) + 8 + textWidth(kindLine(el), GROUP_KIND_PX);
/** A light group shows its name alone, small, in capitals and spaced. */
export function laneLabelWidth(name: string): number { return textWidth(name, LANE_NAME_PX, true) * 1.06; }

/**
 * The title of a group, and the room the layout engine keeps for it with its status badge.
 * The engine is given this size, so a group is never narrower than its title, the title is never cut,
 * and no line is routed over it. A long title puts the kind under the name.
 */
function groupTitle(el: SpecElement, light: boolean): { title: GroupTitle; w: number; h: number } {
  if (light) {
    const name = el.name.toUpperCase();
    const w = Math.ceil(laneLabelWidth(name));
    return { title: { x: 0, y: 0, w, h: 13, name, kind: '', stacked: false }, w, h: 13 };
  }
  const status = active(el.status);
  const stacked = groupLabelWidth(el) > TITLE_MAX;
  const kind = kindLine(el);
  const w = Math.ceil(stacked ? Math.max(textWidth(el.name, GROUP_NAME_PX, true), textWidth(kind, GROUP_KIND_PX)) : groupLabelWidth(el));
  const h = stacked ? 34 : 20;
  return { title: { x: 0, y: 0, w, h, name: el.name, kind, stacked }, w: w + (status ? BADGE_GAP + badgeWidth(status) : 0), h };
}

/**
 * The lines to hand to the layout engine back to front, so that it never sees a cycle and never has
 * to pick which line of one to draw against the flow. The elements are walked in the order given,
 * and each one's lines in the order given: a line that returns to an element still being walked
 * closes a cycle, and is the one drawn backwards. So the element listed first in a cycle is drawn first.
 */
function backLines(starts: string[], lines: { rel: SpecRelationship; i: number }[]): Set<number> {
  const out = new Map<string, { to: string; i: number }[]>();
  for (const { rel, i } of lines) if (rel.from !== rel.to) out.set(rel.from, [...(out.get(rel.from) ?? []), { to: rel.to, i }]);
  const state = new Map<string, 'open' | 'done'>();
  const back = new Set<number>();
  const visit = (id: string): void => {
    state.set(id, 'open');
    for (const { to, i } of out.get(id) ?? []) {
      if (state.get(to) === 'open') back.add(i);
      else if (!state.has(to)) visit(to);
    }
    state.set(id, 'done');
  };
  for (const id of starts) if (!state.has(id)) visit(id);
  return back;
}

/** Counts the places where a flat segment of one line meets an upright segment of the other, away from their ends. */
export function crossings(a: Pt[], b: Pt[]): number {
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

/** Length of a right-angled path. */
export const pathLength = (points: Pt[]): number =>
  points.slice(1).reduce((sum, p, i) => sum + Math.abs(p.x - points[i]!.x) + Math.abs(p.y - points[i]!.y), 0);

/** True when a segment of `a` runs along a segment of `b`, less than `gap` away, for more than `over` pixels. */
export function runsAlong(a: Pt[], b: Pt[], gap: number, over = 1): boolean {
  for (let i = 1; i < a.length; i++) for (let j = 1; j < b.length; j++) {
    const p = a[i - 1]!, q = a[i]!, r = b[j - 1]!, s = b[j]!;
    for (const [u, v] of [['x', 'y'], ['y', 'x']] as const) {
      if (Math.abs(p[u] - q[u]) > 0.5 || Math.abs(r[u] - s[u]) > 0.5 || Math.abs(p[u] - r[u]) >= gap) continue;
      if (Math.min(Math.max(p[v], q[v]), Math.max(r[v], s[v])) - Math.max(Math.min(p[v], q[v]), Math.min(r[v], s[v])) > over) return true;
    }
  }
  return false;
}

/** Move an edge end from the bounding box onto the curved side of a cylinder or pipe. */
function snap(p: Pt, n: NodeBox): void {
  const bulge = (offset: number, half: number): number => 1 - Math.sqrt(Math.max(0, 1 - (offset / half) ** 2));
  if (n.el.type === 'datastore') {
    const k = CYLINDER_RY * bulge(p.x - (n.x + n.w / 2), n.w / 2);
    if (Math.abs(p.y - n.y) < 1) p.y += k;
    else if (Math.abs(p.y - (n.y + n.h)) < 1) p.y -= k;
  } else if (n.el.type === 'queue') {
    const k = PIPE_RX * bulge(p.y - (n.y + n.h / 2), n.h / 2);
    if (Math.abs(p.x - n.x) < 1) p.x += k;
    else if (Math.abs(p.x - (n.x + n.w)) < 1) p.x -= k;
  }
}

/** True when the cards of a spec are drawn without their descriptions: when asked, and past 5 elements unless full detail is asked. */
export function isCompact(spec: DiagramSpec, detail: Detail): boolean {
  const parents = new Set(spec.elements.map((e) => e.parent));
  const leaves = spec.elements.filter((e) => !parents.has(e.id) && e.type !== 'boundary' && e.type !== 'node' && e.type !== 'file').length;
  return detail === 'compact' || (detail === 'auto' && leaves > FULL_DETAIL_MAX);
}

export async function layout(spec: DiagramSpec, opts: LayoutOptions = {}): Promise<Layout> {
  const direction = opts.direction ?? (spec.direction === 'RIGHT' ? 'RIGHT' : 'DOWN');
  const down = direction === 'DOWN';
  const numbered = opts.numbered ?? spec.labels === 'numbered';
  const parents = new Set(spec.elements.map((e) => e.parent));
  const compact = isCompact(spec, opts.detail ?? spec.detail ?? 'auto');
  // A code diagram is drawn tighter, and its groups are light bands.
  const code = spec.type === 'code';
  // One long path stacks every header, so the cards of a diagram match.
  const stack = spec.elements.some(longPath);
  const nodeW = compact && numbered ? NODE_W_FLOW : NODE_W;
  const byId = new Map(spec.elements.map((e) => [e.id, e]));
  const position = new Map(spec.elements.map((e, i) => [e.id, i]));
  const kids = new Map<string | undefined, SpecElement[]>();
  for (const el of spec.elements) {
    // In a code diagram a group takes no room: its name is a label on each of its files, so the files are free to stand in layers.
    if (code && (parents.has(el.id) || el.type === 'boundary' || el.type === 'node')) continue;
    const key = !code && el.parent !== undefined && byId.has(el.parent) ? el.parent : undefined;
    kids.set(key, [...(kids.get(key) ?? []), el]);
  }
  /** The element, then each group that holds it, outermost last. A parent cycle stops at the first repeat. */
  const chain = (id: string): string[] => {
    const out: string[] = [];
    for (let p: string | undefined = id; p !== undefined && byId.has(p) && !out.includes(p); p = code ? undefined : byId.get(p)!.parent) out.push(p);
    return out;
  };

  // Elements in a parent cycle hang from nothing, and are not drawn. Nor is a relationship with an end that is not drawn.
  const placed = new Set<string>();
  const reach = (list: SpecElement[]): void => { for (const el of list) if (!placed.has(el.id)) { placed.add(el.id); reach(kids.get(el.id) ?? []); } };
  reach(kids.get(undefined) ?? []);

  // Shape. A flow reads in step order. Every other diagram reads in the order the spec lists its relationships.
  const lines = spec.relationships.map((rel, i) => ({ rel, i })).filter(({ rel }) => placed.has(rel.from) && placed.has(rel.to));
  if (spec.type === 'dynamic') lines.sort((a, b) => relNumber(spec, a.rel) - relNumber(spec, b.rel) || a.i - b.i);
  // A code diagram left to right has its layers worked out here: no line runs backwards, and a line between two
  // files of one layer is drawn beside them. With no line at all there is nothing to layer, and the cards are packed.
  const shape = code && !down && lines.some(({ rel }) => rel.from !== rel.to) ? codeShape(spec) : undefined;
  const within = (rel: SpecRelationship): boolean => shape !== undefined && rel.from !== rel.to && shape.layer.get(rel.from) === shape.layer.get(rel.to);
  const back = shape ? new Set<number>() : backLines(lines.flatMap(({ rel }) => [rel.from, rel.to]), lines);
  /** The two ends of a line as the layout engine gets them: source first. */
  const flow = (rel: SpecRelationship, i: number): [string, string] => (back.has(i) ? [rel.to, rel.from] : [rel.from, rel.to]);
  // Which elements have a line, themselves or inside them, and which have one arriving from beside them in their group.
  const linked = new Set<string>(), fed = new Set<string>();
  for (const { rel, i } of lines) {
    const [a, z] = flow(rel, i).map(chain) as [string[], string[]];
    for (const id of [...a, ...z]) linked.add(id);
    // The group that holds both ends, and the child of it that the line arrives in.
    const k = z.findIndex((id) => a.includes(id));
    if (k === 0) continue;
    const into = k < 0 ? z.at(-1)! : z[k - 1]!, from = k < 0 ? a.at(-1)! : a[a.indexOf(z[k]!) - 1];
    if (from !== undefined && from !== into) fed.add(into);
  }

  const gap = (px: number): string => String(px);
  const layered = {
    'elk.algorithm': 'layered',
    'elk.direction': direction,
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.layered.spacing.nodeNodeBetweenLayers': gap(code ? 38 : numbered ? 14 : compact ? 18 : 26),
    'elk.spacing.nodeNode': gap(code ? 14 : compact ? 20 : 26),
    'elk.spacing.edgeNode': gap(18),
    'elk.spacing.edgeEdge': gap(14),
    'elk.spacing.edgeLabel': '5',
    'elk.spacing.labelLabel': '6',
    // A self-relationship is a loop this far out of its element, large enough to read.
    'elk.spacing.nodeSelfLoop': '26',
    'elk.layered.spacing.edgeNodeBetweenLayers': gap(compact ? 14 : 20),
    'elk.layered.spacing.edgeEdgeBetweenLayers': gap(12),
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.mergeEdges': 'false',
    ...(opts.wrap ? { 'elk.aspectRatio': String(opts.wrap), 'elk.layered.wrapping.strategy': 'MULTI_EDGE', 'elk.layered.wrapping.additionalEdgeSpacing': '14' } : {}),
  };
  // Parts with no line between them are packed as rectangles. A layered layout is for parts that are joined.
  const packed = {
    'elk.algorithm': 'rectpacking',
    'elk.hierarchyHandling': 'SEPARATE_CHILDREN',
    'elk.aspectRatio': String(opts.wrap ?? PACK_ASPECT),
    'elk.spacing.nodeNode': gap(code ? 14 : compact ? 20 : 26),
  };

  // Symbol rows are ports. Lines that leave one row together share a port, and each line that
  // arrives gets its own, a few pixels from the next, so a reader can follow each to its end.
  type Side = 'w' | 'e';
  const rowOf = (el: SpecElement, symbol: string | undefined): number => {
    const row = symbol === undefined ? -1 : (el.symbols ?? []).findIndex((s) => s.name === symbol);
    return row < CARD_ROWS_MAX ? row : -1;
  };
  const slots = new Map<string, { name: string; rank: number; from?: string }[]>();
  const portId = (id: string, row: number, side: Side, name: string): string => `${id}\u0000${row}\u0000${side}\u0000${name}`;
  /**
   * The port one end of a line uses. Left to right, a line leaves on the right and arrives on the left. A loop, and a
   * line between two files of one layer, leave and arrive on the right. Top down, which a code diagram takes only
   * when the spec names it, every line runs down the right side of the cards, the only way it can still end on a row.
   */
  const port = (rel: SpecRelationship, i: number, end: 'from' | 'to'): string => {
    const el = byId.get(rel[end])!;
    if (el.type !== 'file' || parents.has(el.id)) return el.id;
    const loop = rel.from === rel.to, rev = back.has(i);
    const side: Side = down ? 'e' : end === 'from' ? (rev ? 'w' : 'e') : loop || rev || within(rel) ? 'e' : 'w';
    const row = rowOf(el, end === 'from' ? rel.fromSymbol : rel.toSymbol);
    const name = end === 'from' ? `out${rel.status ?? ''}` : `in${i}`;
    const key = `${el.id}\u0000${row}\u0000${side}`;
    const list = slots.get(key) ?? slots.set(key, []).get(key)!;
    if (!list.some((s) => s.name === name)) list.push({ name, rank: end === 'from' ? -1 : position.get(rel.from) ?? 0, ...(end === 'to' ? { from: rel.from } : {}) });
    return portId(el.id, row, side, name);
  };
  const roots = kids.get(undefined) ?? [];
  const labels = new Map<number, ReturnType<typeof edgeLabel>>();
  const topOf = (id: string): string => chain(id).at(-1)!;
  // elkjs takes and returns plain JSON, so the graph is untyped at this boundary.
  const turnId = (i: number): string => `\u0000turn\u0000${i}`;
  const turns: unknown[] = [];
  const edges: { part: string; edge: any }[] = lines.flatMap(({ rel, i }) => {
    const label = edgeLabel(rel, numbered ? relNumber(spec, rel) : undefined);
    labels.set(i, label);
    const a = port(rel, i, 'from'), z = port(rel, i, 'to');
    const words = label.lines.length ? { labels: [{ id: `l${i}`, text: rel.label, width: label.w, height: label.h, layoutOptions: { 'elk.edgeLabels.inline': 'true' } }] } : {};
    const part = topOf(rel.from);
    if (!within(rel)) return [{ part, edge: { id: `e${i}`, sources: [back.has(i) ? z : a], targets: [back.has(i) ? a : z], ...words } }];
    // The engine has no line inside a layer. So both ends run to a point in the gap to the right of the layer,
    // and the two halves are joined there into one line when the layout is read. The words of such a line are that
    // point: a box of their size, which the line runs down the left side of.
    turns.push({ id: turnId(i), width: label.lines.length ? label.w : 0.1, height: label.lines.length ? label.h : 0.1, layoutOptions: { 'elk.partitioning.partition': String(2 * shape!.layer.get(rel.from)! + 1) } });
    return [{ part, edge: { id: `e${i}`, sources: [a], targets: [turnId(i)] } }, { part, edge: { id: `h${i}`, sources: [z], targets: [turnId(i)] } }];
  });

  // A card is as wide as its longest name. In a code diagram the page is shared out among the layers: a layer whose
  // names are long takes more of it, and only when the layers together are wider than the page are the widest ones narrowed.
  const cardFiles = spec.elements.filter((e) => e.type === 'file' && !parents.has(e.id));
  const lane = (e: SpecElement): string | undefined => (code && e.parent !== undefined ? byId.get(e.parent)?.name : undefined);
  let cardMax = CARD_MAX;
  if (shape) {
    const want = new Array<number>(shape.layers).fill(CARD_MIN);
    for (const e of cardFiles) { const k = shape.layer.get(e.id) ?? 0; want[k] = Math.max(want[k]!, fileCard(e, stack, CARD_WIDEST, lane(e)).w); }
    // Words on a line sit in the gap to the right of the layer it leaves, and widen that gap.
    const gaps = new Array<number>(shape.layers).fill(0);
    for (const { rel, i } of lines) { const k = shape.layer.get(rel.from) ?? 0; gaps[k] = Math.max(gaps[k]!, labels.get(i)?.w ?? 0); }
    const room = PAGE - LAYER_GAP * (shape.layers - 1) - gaps.reduce((n, w) => n + w, 0);
    let lo = CARD_MIN, hi = CARD_WIDEST;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (want.reduce((n, w) => n + Math.min(w, mid), 0) <= room) lo = mid; else hi = mid; }
    cardMax = lo;
  }
  const sizes = new Map(cardFiles.map((e) => [e.id, fileCard(e, stack, cardMax, lane(e))]));
  const partition = (id: string): Record<string, string> => (shape ? { 'elk.partitioning.partition': String(2 * (shape.layer.get(id) ?? 0)) } : {});
  const boxes = new Map<string, NodeBox>();
  const titleId = (id: string): string => `\u0000title\u0000${id}`;
  /** Groups whose title sits in the padding at the top, with how far in. The rest have a title the engine placed. */
  const strips = new Map<string, { x: number; y: number }>();
  const isGroup = (el: SpecElement): boolean => (kids.get(el.id) ?? []).length > 0 || el.type === 'boundary' || el.type === 'node';
  const build = (el: SpecElement, depth: number, seen: Set<string>): any => {
    const children = seen.has(el.id) ? [] : (kids.get(el.id) ?? []);
    const group = children.length > 0 || el.type === 'boundary' || el.type === 'node';
    if (!group && el.type === 'file') {
      const { w, h, card } = sizes.get(el.id)!;
      boxes.set(el.id, { el, group, depth, x: 0, y: 0, w, h, lines: [], card });
      const ports: unknown[] = down ? [{ id: portId(el.id, -2, 'w', 'top'), x: w / 2, y: 0, width: 0, height: 0, layoutOptions: { 'elk.port.side': 'NORTH' } }] : [];
      for (const [row, dy] of [[-1, card.head / 2] as const, ...card.rows.map((r, i) => [i, r.dy] as const)]) for (const side of ['w', 'e'] as const) {
        const list = [...(slots.get(`${el.id}\u0000${row}\u0000${side}`) ?? [])].sort((a, b) => a.rank - b.rank);
        const step = list.length > 1 ? Math.min(PORT_GAP, (CARD_ROW - 8) / (list.length - 1)) : 0;
        list.forEach((slot, k) => ports.push({
          id: portId(el.id, row, side, slot.name), x: side === 'w' ? 0 : w, y: dy + (k - (list.length - 1) / 2) * step, width: 0, height: 0,
          layoutOptions: { 'elk.port.side': side === 'w' ? 'WEST' : 'EAST' },
        }));
      }
      return { id: el.id, width: w, height: h, layoutOptions: { 'elk.portConstraints': 'FIXED_POS', ...partition(el.id) }, ports };
    }
    const light = code && group;
    const text = group ? { h: light ? 48 : 64, lines: [] } : leafText(el, compact, nodeW);
    if (!group) {
      boxes.set(el.id, { el, group, depth, x: 0, y: 0, w: nodeW, h: text.h, lines: text.lines });
      return { id: el.id, width: nodeW, height: text.h, layoutOptions: partition(el.id) };
    }
    const { title, w: titleW, h: titleH } = groupTitle(el, light);
    const side = light ? 10 : compact ? 14 : 18, top = light ? 8 : 10;
    const emptyW = Math.max(light ? 120 : 160, titleW + 2 * side);
    boxes.set(el.id, { el, group, depth, x: 0, y: 0, w: emptyW, h: text.h, lines: [], title, ...(light ? { light } : {}) });
    if (!children.length) { strips.set(el.id, { x: side, y: top }); return { id: el.id, width: emptyW, height: text.h }; }
    const below = new Set(seen).add(el.id);
    const nodes = children.map((c) => build(c, depth + 1, below));
    // Left to right, lines enter a group through its sides, never through its top: the title sits there, in the padding.
    // The same holds for a group that no line touches. Top down, lines come in through the top, so the title is a box
    // of its own in a first row of the group, and the engine routes round it as it does round any box.
    const strip = !down || !linked.has(el.id);
    if (strip) strips.set(el.id, { x: side, y: top });
    else {
      nodes.unshift({ id: titleId(el.id), width: titleW, height: titleH });
      for (const c of children) {
        if (fed.has(c.id)) continue;
        const onto = c.type === 'file' && !isGroup(c) ? portId(c.id, -2, 'w', 'top') : isGroup(c) && (kids.get(c.id) ?? []).length && linked.has(c.id) ? titleId(c.id) : c.id;
        edges.push({ part: topOf(el.id), edge: { id: `t${edges.length}`, sources: [titleId(el.id)], targets: [onto] } });
      }
    }
    return {
      id: el.id,
      layoutOptions: {
        ...(linked.has(el.id) ? layered : packed),
        'elk.padding': `[top=${strip ? top + titleH + 8 : top},left=${side},bottom=${side},right=${side}]`,
        ...(strip ? { 'elk.nodeSize.constraints': 'MINIMUM_SIZE', 'elk.nodeSize.minimum': `(${titleW + 2 * side},${text.h})` } : {}),
      },
      children: nodes,
    };
  };

  // Parts of the drawing with no line between them are laid out one by one and packed side by side.
  const part = new Map(roots.map((el) => [el.id, el.id]));
  const find = (id: string): string => { let p = id; while (part.get(p) !== p) p = part.get(p)!; return p; };
  for (const { rel } of lines) part.set(find(topOf(rel.from)), find(topOf(rel.to)));
  let built = new Map(roots.map((el) => [el.id, build(el, 0, new Set())]));
  const parts = new Map<string, string[]>();
  for (const el of roots) parts.set(find(el.id), [...(parts.get(find(el.id)) ?? []), el.id]);
  const frame = { 'elk.padding': '[top=0,left=0,bottom=0,right=0]', 'elk.json.edgeCoords': 'ROOT', 'elk.json.shapeCoords': 'ROOT' };
  const graph = (modelOrder: boolean): unknown => {
    const joined = { ...layered, ...(modelOrder ? { 'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES' } : {}), ...frame };
    const inside = (ids: string[]): unknown[] => edges.filter((e) => ids.includes(find(e.part)) || ids.includes(e.part)).map((e) => e.edge);
    // The layers of a code diagram are partitions, in order: the engine keeps each file in its own, and the turn points between them.
    // Files folded into a layer from further out keep the order of the chain inside it, top to bottom.
    if (shape) {
      const folded = shape.beyond.length > 0;
      const children = [...built.values()];
      if (folded) children.sort((x, y) => (shape.rank.get(x.id) ?? 0) - (shape.rank.get(y.id) ?? 0));
      return { id: 'root', layoutOptions: { ...joined, 'elk.partitioning.activate': 'true', ...(folded ? { 'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES', 'elk.layered.crossingMinimization.forceNodeModelOrder': 'true' } : {}) }, children: [...children, ...turns], edges: edges.map((e) => e.edge) };
    }
    if (parts.size <= 1) return { id: 'root', layoutOptions: joined, children: [...built.values()], edges: inside([...built.keys()]) };
    return {
      id: 'root',
      layoutOptions: { ...packed, ...frame, 'elk.spacing.nodeNode': gap(26) },
      children: [...parts.values()].map((ids, k) => (ids.length === 1 && !linked.has(ids[0]!) ? built.get(ids[0]!)
        : { id: `\u0000part\u0000${k}`, layoutOptions: joined, children: ids.map((id) => built.get(id)), edges: inside(ids) })),
    };
  };
  const elk = new (ELK as any)();
  // ELK writes its results into the graph it is given, so each run gets a copy: a second run must not overwrite the first.
  const run = (modelOrder: boolean): Promise<any> => elk.layout(structuredClone(graph(modelOrder))).catch(() => elk.layout(structuredClone(graph(false))));
  // Model order keeps the layout close to the order the spec lists things in.
  // ELK rejects it on some nested graphs, so the second attempt runs without it.
  let done = await run(true);
  // Lines that arrive at one row each have a port, and their order on the side of the card is fixed before the
  // engine runs. So the first layout tells where each line comes from, and the ports are put in that order, top to
  // bottom, for a second layout: lines that reach one row from above arrive above, and do not cross on the way in.
  // The second layout may move the cards again, so it is kept only when its lines cross less.
  if ([...slots.values()].some((list) => list.filter((x) => x.from !== undefined).length > 1)) {
    const routes = (node: any, out: Pt[][] = []): Pt[][] => {
      for (const e of node.edges ?? []) out.push((e.sections ?? []).flatMap((s: any) => [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]));
      for (const c of node.children ?? []) routes(c, out);
      return out;
    };
    const crossed = (node: any): number => { const all = routes(node); let n = 0; all.forEach((a, k) => { for (const b of all.slice(k + 1)) n += crossings(a, b); }); return n; };
    const centre = new Map<string, number>();
    const walk = (node: any): void => { for (const c of node.children ?? []) { centre.set(String(c.id), c.y + c.height / 2); walk(c); } };
    walk(done);
    const first = { done, built, ranks: [...slots.values()].map((list) => list.map((x) => x.rank)) };
    for (const list of slots.values()) for (const x of list) if (x.from !== undefined) x.rank = centre.get(x.from) ?? x.rank;
    built = new Map(roots.map((el) => [el.id, build(el, 0, new Set())]));
    const second = await run(true);
    if (crossed(second) < crossed(first.done)) done = second;
    else {
      [...slots.values()].forEach((list, k) => list.forEach((x, m) => { x.rank = first.ranks[k]![m]!; }));
      built = new Map(roots.map((el) => [el.id, build(el, 0, new Set())]));
    }
  }

  const paths: EdgePath[] = [];
  /** The second half of each line that stays inside a layer: from its target out to the turn point. */
  const halves = new Map<number, Pt[]>();
  const turnAt = new Map<number, Rect>();
  const read = (node: any): void => {
    for (const child of node.children ?? []) {
      const id = String(child.id);
      if (id.startsWith('\u0000turn\u0000')) turnAt.set(Number(id.slice(6)), { x: child.x, y: child.y, w: child.width, h: child.height });
      else if (id.startsWith('\u0000title\u0000')) Object.assign(boxes.get(id.slice(7))!.title!, { x: child.x, y: child.y });
      else if (boxes.has(id)) Object.assign(boxes.get(id)!, { x: child.x, y: child.y, w: child.width, h: child.height });
      read(child);
    }
    for (const edge of node.edges ?? []) {
      const i = Number(String(edge.id).slice(1));
      const rel = spec.relationships[i]!;
      const points: Pt[] = (edge.sections ?? []).flatMap((s: any) => [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]).map((p: Pt) => ({ x: p.x, y: p.y }));
      if (String(edge.id).startsWith('h')) { halves.set(i, points); continue; }
      if (!String(edge.id).startsWith('e')) continue;
      if (back.has(i)) points.reverse();
      const placed = edge.labels?.[0];
      const label = labels.get(i)!;
      paths.push({ rel, points, label: placed ? { x: placed.x, y: placed.y, w: label.w, h: label.h, lines: label.lines } : undefined });
    }
  };
  read(done);
  // A line inside a layer is its two halves, joined at the turn point. When both halves reach the point on one
  // level, the point and the stretch they share are left out, and the line turns where the first half did. When
  // they reach the side of a box of words at two levels, the line runs down that side between them.
  for (const path of paths) {
    const i = spec.relationships.indexOf(path.rel);
    const half = halves.get(i);
    if (!half) continue;
    if (path.points.length < 2 || half.length < 2) { path.points = []; continue; }
    const p = path.points.at(-1)!, q = half.at(-1)!;
    path.points = Math.abs(p.y - q.y) < 0.5 ? [...path.points.slice(0, -1), ...half.slice(0, -1).reverse()] : [...path.points, ...half.slice().reverse()];
    const label = labels.get(i)!, at = turnAt.get(i);
    if (label.lines.length && at) path.label = { x: at.x, y: at.y, w: label.w, h: label.h, lines: label.lines };
  }
  // A relationship the engine gave no route is kept with no points, so that it is counted as not drawn.
  for (const { rel } of lines) if (!paths.some((p) => p.rel === rel)) paths.push({ rel, points: [] });
  // The engine centres a title box over the boxes under it. It is moved to the left of its row, as far as the
  // row is empty: the row was kept for it, and the move stops at the first line or label, so it cannot cover one.
  for (const b of boxes.values()) {
    const t = b.title;
    if (!t || strips.has(b.el.id)) continue;
    const row: Rect = { x: b.x, y: t.y - 4, w: t.x - b.x, h: t.h + 8 };
    let left = b.x + (b.light ? 10 : compact ? 14 : 18);
    for (const p of paths) {
      for (let i = 1; i < p.points.length; i++) {
        const far = Math.max(p.points[i - 1]!.x, p.points[i]!.x);
        if (far < t.x && crossesRect([p.points[i - 1]!, p.points[i]!], row)) left = Math.max(left, far + 10);
      }
      if (p.label && p.label.x < t.x && p.label.y < row.y + row.h && p.label.y + p.label.h > row.y) left = Math.max(left, p.label.x + p.label.w + 10);
    }
    t.x = Math.min(t.x, left);
  }
  for (const b of boxes.values()) {
    const at = strips.get(b.el.id);
    if (b.title && at) Object.assign(b.title, { x: b.x + at.x, y: b.y + at.y });
    const status = active(b.el.status);
    b.badge = b.title ? (status && !b.light ? { x: b.title.x + b.title.w + BADGE_GAP, y: b.title.y + 2, w: badgeWidth(status), h: BADGE_H } : undefined) : leafBadge(b);
  }
  for (const path of paths) {
    if (path.points.length < 2) continue;
    snap(path.points[0]!, boxes.get(path.rel.from)!);
    snap(path.points.at(-1)!, boxes.get(path.rel.to)!);
  }
  paths.sort((a, b) => spec.relationships.indexOf(a.rel) - spec.relationships.indexOf(b.rel));
  // A wrap that cut nothing gives the same drawing as no wrap.
  const wrapped = Boolean(opts.wrap) && paths.some((p) => {
    const a = boxes.get(p.rel.from)!, z = boxes.get(p.rel.to)!;
    if (a === z || back.has(spec.relationships.indexOf(p.rel))) return false;
    return down ? z.x >= a.x + a.w && z.y < a.y : z.y >= a.y + a.h && z.x < a.x;
  });
  return { width: done.width ?? 0, height: done.height ?? 0, nodes: [...boxes.values()], edges: paths, direction, numbered, compact, wrapped };
}
