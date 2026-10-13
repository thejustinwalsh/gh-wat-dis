import ELK from 'elkjs/lib/elk.bundled.js';
import type { Detail, DiagramSpec, SpecElement, SpecRelationship } from '../spec.ts';
import { fit, monoWidth, textWidth, wrap } from './measure.ts';
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
  /** The name of the group the file is in, drawn above the card when the groups are not drawn as bands. */
  lane?: string;
}
export interface NodeBox {
  el: SpecElement;
  group: boolean;
  depth: number;
  x: number; y: number; w: number; h: number;
  lines: TextLine[];
  /** Where the status badge is drawn. It lies inside the box, where no relationship line runs. */
  badge?: Rect;
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
  /** True when the groups of a code diagram are names above the cards. */
  flat: boolean;
}
export interface LayoutOptions {
  detail?: Detail;
  direction?: 'DOWN' | 'RIGHT';
  numbered?: boolean;
  /** Target width / height. When set, ELK may wrap a long chain onto a second row or column. */
  wrap?: number;
  /** In a code diagram, name the group above each file card in place of a band around the group's files. */
  flat?: boolean;
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
/** A group keeps this much clear on each side of its label. */
export const GROUP_PAD_X = 14;
const BADGE_GAP = 10;
/** How far a self-relationship reaches out of its element, and how much of the side it spans. */
const LOOP_OUT = 30;
const LOOP_SPAN = 34;
const LOOP_SPAN_MAX = 48;
/** ELK draws a self-loop about 10px deep. Its label is given this much more room so the larger loop fits. */
const LOOP_PAD = LOOP_OUT - 10;
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
const CARD_ROWS_MAX = 8;
/** Room above a card for the name of its group. */
const LANE_CAP = 17;
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

const monoFit = (text: string, px: number, max: number): string => {
  const chars = [...text];
  if (monoWidth(text, px) <= max) return text;
  while (chars.length > 1 && monoWidth(chars.join('') + '\u2026', px) > max) chars.pop();
  return chars.join('') + '\u2026';
};

/** True when the path of a file is too wide for one line of a card header. */
const longPath = (el: SpecElement): boolean => {
  const cut = el.name.lastIndexOf('/') + 1;
  return el.type === 'file' && textWidth(el.name.slice(0, cut), CARD_PATH_PX) + textWidth(el.name.slice(cut), CARD_PATH_PX, true) + 15 > CARD_PATH_MAX;
};

/** A file card is as wide as its longest line, within limits. A long path loses its leading folders first. */
function fileCard(el: SpecElement, stack: boolean): { w: number; h: number; card: FileCard } {
  const mark = active(el.status) ? 15 : 0;
  const cut = el.name.lastIndexOf('/') + 1;
  let dir = el.name.slice(0, cut);
  const stacked = stack && dir !== '';
  const head = stacked ? CARD_HEAD_STACKED : CARD_HEAD;
  const dirPx = stacked ? CARD_DIR_PX : CARD_PATH_PX;
  const room = CARD_MAX - 2 * CARD_PAD - mark;
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
  const w = Math.ceil(Math.min(CARD_MAX, Math.max(CARD_MIN, pathWidth(dir, base) + mark + 2 * CARD_PAD, rowWidth, note ? textWidth(note, 11) + 2 * CARD_PAD : 0)));
  const rows: CardRow[] = symbols.map((s, i) => ({
    name: monoFit(s.name, CARD_SYMBOL_PX, w - CARD_NAME_X - kindWidth(s.kind) - CARD_PAD),
    ...(s.kind ? { kind: s.kind } : {}), ...(active(s.status) ? { status: active(s.status)! } : {}),
    dy: head + 4 + i * CARD_ROW + CARD_ROW / 2,
  }));
  let h = head + (rows.length ? rows.length * CARD_ROW + 9 : 0);
  const card: FileCard = { dir, base, rows, head, stacked };
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
  for (const line of wrap(text, 11.5, LABEL_MAX)) {
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

/** Width of a group's label on one line: name, then kind. */
export const groupLabelWidth = (el: SpecElement): number =>
  textWidth(el.name, GROUP_NAME_PX, true) + 8 + textWidth(kindLine(el), GROUP_KIND_PX);
/** A light group shows its name alone, small and spaced. */
export const laneLabelWidth = (el: SpecElement): number => textWidth(el.name, LANE_NAME_PX, true) * 1.06;

/** The narrowest a group can be and still show its label on one line, with its badge beside it. */
export function groupMinWidth(el: SpecElement, light = false): number {
  if (light) return Math.ceil(laneLabelWidth(el) + 2 * 10);
  const status = active(el.status);
  return Math.ceil(groupLabelWidth(el) + 2 * GROUP_PAD_X + 2 + (status ? badgeWidth(status) + BADGE_GAP : 0));
}

/**
 * The badge of a group sits in the label row, as far right as it can without covering a line.
 * Lines cross a group to reach its children, so the row is searched for a clear place.
 * `hits` counts the lines under the best place found; `layout` widens the group when it is not 0.
 */
function groupBadge(b: NodeBox, edges: EdgePath[]): { rect: Rect; hits: number } | undefined {
  const status = active(b.el.status);
  if (!status) return undefined;
  const w = badgeWidth(status);
  const y = b.y + 13;
  const right = b.x + b.w - 12 - w;
  const left = Math.min(right, b.x + GROUP_PAD_X + groupLabelWidth(b.el) + BADGE_GAP);
  const places: number[] = [];
  for (let x = right; x >= left; x -= 2) places.push(x);
  places.push(right + 2, right + 4, right + 6);
  let best = { x: right, hits: Infinity };
  for (const x of places) {
    const hits = edges.filter((e) => crossesRect(e.points, { x, y, w, h: BADGE_H }, 4)).length;
    if (hits < best.hits) best = { x, hits };
    if (hits === 0) break;
  }
  return { rect: { x: best.x, y, w, h: BADGE_H }, hits: best.hits };
}

type Side = 'N' | 'E' | 'S' | 'W';
function sideOf(p: Pt, b: Rect): Side | undefined {
  if (Math.abs(p.y - b.y) < 0.5) return 'N';
  if (Math.abs(p.y - (b.y + b.h)) < 0.5) return 'S';
  if (Math.abs(p.x - b.x) < 0.5) return 'W';
  if (Math.abs(p.x - (b.x + b.w)) < 0.5) return 'E';
  return undefined;
}

/**
 * ELK draws a self-relationship as a loop about 10px deep, too small to read.
 * This redraws it on the same side of the element, deeper and wider, and puts the label beyond it.
 * `placed` is the room ELK kept for the label, which `LOOP_PAD` made large enough for both.
 */
function growLoop(path: EdgePath, box: NodeBox, placed: Rect | undefined, others: EdgePath[]): void {
  const first = path.points[0], last = path.points.at(-1);
  const label = path.label;
  if (label && placed) {
    label.x = placed.x + (placed.w - label.w) / 2;
    label.y = placed.y + (placed.h - label.h) / 2;
  }
  if (!first || !last || path.points.length < 2) return;
  const side = sideOf(first, box);
  if (!side || side !== sideOf(last, box)) return;
  const flat = side === 'N' || side === 'S';
  const along = (p: Pt): number => (flat ? p.x : p.y);
  const corner = box.el.type === 'person' ? 20 : 8;
  let lo = (flat ? box.x : box.y) + corner, hi = (flat ? box.x + box.w : box.y + box.h) - corner;
  const mid = (along(first) + along(last)) / 2;
  // Stay clear of the other lines that end on this side.
  for (const other of others) {
    const ends = [other.rel.from === box.el.id ? other.points[0] : undefined, other.rel.to === box.el.id ? other.points.at(-1) : undefined];
    for (const p of ends) {
      if (!p || sideOf(p, box) !== side) continue;
      if (along(p) < mid) lo = Math.max(lo, along(p) + 10); else hi = Math.min(hi, along(p) - 10);
    }
  }
  const span = Math.min(Math.max(Math.abs(along(last) - along(first)), LOOP_SPAN), LOOP_SPAN_MAX, Math.max(0, hi - lo));
  if (span < 16) return;
  const start = Math.max(lo, Math.min(mid - span / 2, hi - span));
  const [a, z] = along(first) <= along(last) ? [start, start + span] : [start + span, start];
  const out = side === 'N' ? box.y - LOOP_OUT : side === 'S' ? box.y + box.h + LOOP_OUT : side === 'W' ? box.x - LOOP_OUT : box.x + box.w + LOOP_OUT;
  const edge = side === 'N' ? box.y : side === 'S' ? box.y + box.h : side === 'W' ? box.x : box.x + box.w;
  const pt = (pos: number, depth: number): Pt => (flat ? { x: pos, y: depth } : { x: depth, y: pos });
  path.points = [pt(a, edge), pt(a, out), pt(z, out), pt(z, edge)];
  if (!label) return;
  const centre = start + span / 2;
  if (flat) {
    label.x = centre - label.w / 2;
    label.y = side === 'N' ? out - 5 - label.h : out + 5;
  } else {
    label.y = centre - label.h / 2;
    label.x = side === 'W' ? out - 5 - label.w : out + 5;
  }
}

/** Length of a right-angled path. */
export const pathLength = (points: Pt[]): number =>
  points.slice(1).reduce((sum, p, i) => sum + Math.abs(p.x - points[i]!.x) + Math.abs(p.y - points[i]!.y), 0);

const turn = (p: Pt): Pt => ({ x: p.y, y: p.x });
const turnRect = (r: Rect): Rect => ({ x: r.y, y: r.x, w: r.h, h: r.w });

/** True when a segment of `a` runs along a segment of `b`, less than `gap` away. */
function runsAlong(a: Pt[], b: Pt[], gap: number): boolean {
  for (let i = 1; i < a.length; i++) for (let j = 1; j < b.length; j++) {
    const p = a[i - 1]!, q = a[i]!, r = b[j - 1]!, s = b[j]!;
    for (const [u, v] of [['x', 'y'], ['y', 'x']] as const) {
      if (Math.abs(p[u] - q[u]) > 0.5 || Math.abs(r[u] - s[u]) > 0.5 || Math.abs(p[u] - r[u]) >= gap) continue;
      if (Math.min(Math.max(p[v], q[v]), Math.max(r[v], s[v])) - Math.max(Math.min(p[v], q[v]), Math.min(r[v], s[v])) > 1) return true;
    }
  }
  return false;
}

/**
 * When ELK wraps a chain, it routes the cut line out past the end of the row, back along the
 * channel between the rows, and in from the far side. This draws the short way instead: out of
 * the near side of the source, along the same channel, and into the target. The ELK route stays
 * when the short one would touch another element, a group that holds neither end, or another line.
 */
function shortenWrap(path: EdgePath, boxes: Map<string, NodeBox>, others: EdgePath[], direction: 'DOWN' | 'RIGHT'): void {
  const from = boxes.get(path.rel.from)!, to = boxes.get(path.rel.to)!;
  if (from === to || path.points.length < 6) return;
  // The work is done as if rows run left to right. A top-down layout is turned on its side first.
  const t = direction === 'DOWN';
  const rect = (r: Rect): Rect => (t ? turnRect(r) : r);
  const pts = t ? path.points.map(turn) : path.points;
  const a = rect(from), z = rect(to);
  if (z.y < a.y + a.h + 16) return;
  let channel: number | undefined, longest = 0;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1]!, q = pts[i]!;
    if (Math.abs(p.y - q.y) > 0.5 || p.y <= a.y + a.h + 6 || p.y >= z.y - 6 || Math.abs(p.x - q.x) <= longest) continue;
    longest = Math.abs(p.x - q.x);
    channel = p.y;
  }
  if (channel === undefined) return;
  // A group name sits above the left of a card, so the line comes in right of the middle.
  const named = !t && to.card?.lane !== undefined;
  const ax = a.x + a.w / 2, zx = z.x + z.w * (named ? 0.75 : 0.5);
  const short: Pt[] = Math.abs(ax - zx) < 1
    ? [{ x: ax, y: a.y + a.h }, { x: ax, y: z.y }]
    : [{ x: ax, y: a.y + a.h }, { x: ax, y: channel }, { x: zx, y: channel }, { x: zx, y: z.y }];
  if (pathLength(short) > pathLength(pts) * 0.7) return;
  const label = path.label;
  const mid = short.length === 2 ? { x: ax, y: (a.y + a.h + z.y) / 2 } : { x: (ax + zx) / 2, y: channel };
  const lw = label ? (t ? label.h : label.w) : 0, lh = label ? (t ? label.w : label.h) : 0;
  const spot: Rect = { x: mid.x - lw / 2, y: mid.y - lh / 2, w: lw, h: lh };
  const inner = [{ x: ax, y: a.y + a.h + 1 }, ...short.slice(1, -1), { x: zx, y: z.y - 1 }];
  const holds = (g: NodeBox, b: NodeBox): boolean => {
    const seen = new Set<string>();
    for (let p: NodeBox | undefined = b; p && !seen.has(p.el.id); p = p.el.parent !== undefined ? boxes.get(p.el.parent) : undefined) {
      if (p === g) return true;
      seen.add(p.el.id);
    }
    return false;
  };
  for (const b of boxes.values()) {
    if (b === from || b === to || (b.group && (holds(b, from) || holds(b, to)))) continue;
    const r = rect(b);
    if (crossesRect(inner, r, b.group ? 0 : 8)) return;
    if (label && !b.group && spot.x < r.x + r.w + 2 && spot.x + spot.w > r.x - 2 && spot.y < r.y + r.h + 2 && spot.y + spot.h > r.y - 2) return;
  }
  for (const other of others) {
    const o = t ? other.points.map(turn) : other.points;
    if (runsAlong(short, o, 8) || (label && crossesRect(o, spot, 2))) return;
  }
  path.points = t ? short.map(turn) : short;
  if (label) Object.assign(label, t ? { x: spot.y, y: spot.x } : { x: spot.x, y: spot.y });
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

export async function layout(spec: DiagramSpec, opts: LayoutOptions = {}): Promise<Layout> {
  const direction = opts.direction ?? (spec.direction === 'RIGHT' ? 'RIGHT' : 'DOWN');
  const numbered = opts.numbered ?? spec.labels === 'numbered';
  const detail = opts.detail ?? spec.detail ?? 'auto';
  const parents = new Set(spec.elements.map((e) => e.parent));
  const leaves = spec.elements.filter((e) => !parents.has(e.id) && e.type !== 'boundary' && e.type !== 'node' && e.type !== 'file').length;
  const compact = detail === 'compact' || (detail === 'auto' && leaves > FULL_DETAIL_MAX);
  // A code diagram is drawn tighter, and its groups are light bands.
  const code = spec.type === 'code';
  // One long path stacks every header, so the cards of a diagram match.
  const stack = spec.elements.some(longPath);
  const nodeW = compact && numbered ? NODE_W_FLOW : NODE_W;
  const ids = new Set(spec.elements.map((e) => e.id));
  const byId = new Map(spec.elements.map((e) => [e.id, e]));
  // Top down, lines arrive from above, where the name would be. So the flat form is for left to right only.
  const flat = code && direction === 'RIGHT' && Boolean(opts.flat) && spec.elements.some((e) => e.parent !== undefined && ids.has(e.parent));
  const kids = new Map<string | undefined, SpecElement[]>();
  for (const el of spec.elements) {
    // Flat, the files stand alone and the groups are not laid out.
    if (flat && parents.has(el.id)) continue;
    const key = !flat && el.parent !== undefined && ids.has(el.parent) ? el.parent : undefined;
    kids.set(key, [...(kids.get(key) ?? []), el]);
  }
  const common = {
    'elk.algorithm': 'layered',
    'elk.direction': direction,
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.layered.spacing.nodeNodeBetweenLayers': code ? '38' : numbered ? '14' : compact ? '18' : '26',
    'elk.spacing.nodeNode': code ? '14' : compact ? '20' : '26',
    'elk.spacing.edgeNode': '18',
    'elk.spacing.edgeEdge': '14',
    'elk.spacing.edgeLabel': '5',
    'elk.spacing.labelLabel': '6',
    'elk.layered.spacing.edgeNodeBetweenLayers': compact ? '14' : '20',
    'elk.layered.spacing.edgeEdgeBetweenLayers': '12',
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.mergeEdges': 'false',
    ...(opts.wrap ? { 'elk.aspectRatio': String(opts.wrap), 'elk.layered.wrapping.strategy': 'MULTI_EDGE', 'elk.layered.wrapping.additionalEdgeSpacing': '14' } : {}),
  };
  const boxes = new Map<string, NodeBox>();
  // elkjs takes and returns plain JSON, so the graph is untyped at this boundary.
  const build = (el: SpecElement, depth: number, seen: Set<string>, widen: Map<string, number>): any => {
    const children = seen.has(el.id) ? [] : (kids.get(el.id) ?? []);
    const group = children.length > 0 || el.type === 'boundary' || el.type === 'node';
    if (!group && el.type === 'file') {
      const { w, h: cardH, card } = fileCard(el, stack);
      const lane = flat && el.parent !== undefined ? byId.get(el.parent)?.name : undefined;
      if (lane) card.lane = lane;
      const cap = lane ? LANE_CAP : 0, h = cardH + cap;
      boxes.set(el.id, { el, group, depth, x: 0, y: 0, w, h, lines: [], card });
      // Left to right, a line ends on the row it concerns: each row and the header has a port on both sides.
      if (direction !== 'RIGHT') return { id: el.id, width: w, height: h };
      const port = (row: number, dy: number): unknown[] => (['w', 'e'] as const).map((side) => ({
        id: portId(el.id, row, side), x: side === 'w' ? 0 : w, y: dy + cap, width: 0, height: 0,
        layoutOptions: { 'elk.port.side': side === 'w' ? 'WEST' : 'EAST' },
      }));
      return {
        id: el.id, width: w, height: h, layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
        ports: [...port(-1, card.head / 2), ...card.rows.flatMap((r, i) => port(i, r.dy))],
      };
    }
    const light = code && group;
    const text = group ? { h: light ? 48 : 64, lines: [] } : leafText(el, compact, nodeW);
    const emptyW = Math.max(light ? 120 : 160, groupMinWidth(el, light));
    boxes.set(el.id, { el, group, depth, x: 0, y: 0, w: group ? emptyW : nodeW, h: text.h, lines: text.lines, ...(light ? { light } : {}) });
    if (!group) return { id: el.id, width: nodeW, height: text.h };
    const below = new Set(seen).add(el.id);
    const side = light ? 10 : compact ? 14 : 18;
    return {
      id: el.id,
      width: emptyW,
      height: text.h,
      layoutOptions: {
        ...common,
        'elk.padding': `[top=${light ? 28 : compact ? 38 : 46},left=${side},bottom=${side},right=${side + (widen.get(el.id) ?? 0)}]`,
      },
      children: children.map((c) => build(c, depth + 1, below, widen)),
    };
  };
  const portId = (id: string, row: number, side: 'w' | 'e'): string => `${id}\u0000${row}\u0000${side}`;
  /** The node, or the port of the symbol row or the header, that one end of a line attaches to. */
  const end = (id: string, symbol: string | undefined, side: 'w' | 'e'): string => {
    const b = boxes.get(id)!;
    if (!b.card || direction !== 'RIGHT') return id;
    const row = symbol === undefined ? -1 : (b.el.symbols ?? []).findIndex((s) => s.name === symbol);
    return portId(id, row < b.card.rows.length ? row : -1, side);
  };
  const labels = new Map<number, ReturnType<typeof edgeLabel>>();
  const elk = new (ELK as any)();
  const run = async (widen: Map<string, number>): Promise<any> => {
    boxes.clear();
    const children = (kids.get(undefined) ?? []).map((el) => build(el, 0, new Set(), widen));
    const edges = spec.relationships.flatMap((rel, i) => {
      if (!boxes.has(rel.from) || !boxes.has(rel.to)) return [];
      const label = edgeLabel(rel, numbered ? relNumber(spec, rel) : undefined);
      labels.set(i, label);
      const pad = rel.from === rel.to ? LOOP_PAD : 0;
      const ends = { sources: [end(rel.from, rel.fromSymbol, 'e')], targets: [end(rel.to, rel.toSymbol, 'w')] };
      if (!label.lines.length) return [{ id: `e${i}`, ...ends }];
      return [{ id: `e${i}`, ...ends, labels: [{ id: `l${i}`, text: rel.label, width: label.w + pad, height: label.h + pad, layoutOptions: { 'elk.edgeLabels.inline': 'true' } }] }];
    });
    // Model order keeps the layout close to the order the spec lists things in.
    // ELK rejects it on some nested graphs, so the second attempt runs without it.
    const graph = (modelOrder: boolean): unknown => ({
      id: 'root',
      layoutOptions: {
        ...common,
        ...(modelOrder ? { 'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES' } : {}),
        'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
        'elk.padding': '[top=0,left=0,bottom=0,right=0]',
        'elk.json.edgeCoords': 'ROOT',
        'elk.json.shapeCoords': 'ROOT',
      },
      children,
      edges,
    });
    const done = await elk.layout(graph(true)).catch(() => elk.layout(graph(false)));
    const place = (node: any): void => {
      for (const child of node.children ?? []) {
        const b = boxes.get(child.id)!;
        // The card starts under the name of its group.
        const cap = b.card?.lane ? LANE_CAP : 0;
        Object.assign(b, { x: child.x, y: child.y + cap, w: child.width, h: child.height - cap });
        place(child);
      }
    };
    place(done);
    return done;
  };
  const read = (done: any): EdgePath[] => {
    const paths: EdgePath[] = [];
    const loops: { path: EdgePath; placed?: Rect }[] = [];
    const walk = (node: any): void => {
      for (const child of node.children ?? []) walk(child);
      for (const edge of node.edges ?? []) {
        const i = Number(String(edge.id).slice(1));
        const rel = spec.relationships[i]!;
        const points: Pt[] = (edge.sections ?? []).flatMap((s: any) => [s.startPoint, ...(s.bendPoints ?? []), s.endPoint])
          .map((p: Pt) => ({ x: p.x, y: p.y }));
        const placed = edge.labels?.[0];
        const label = labels.get(i)!;
        const path: EdgePath = { rel, points, label: placed ? { x: placed.x, y: placed.y, w: label.w, h: label.h, lines: label.lines } : undefined };
        paths.push(path);
        if (rel.from === rel.to) loops.push({ path, placed: placed ? { x: placed.x, y: placed.y, w: placed.width, h: placed.height } : undefined });
      }
    };
    walk(done);
    for (const { path, placed } of loops) growLoop(path, boxes.get(path.rel.from)!, placed, paths.filter((p) => p !== path));
    if (opts.wrap) for (const path of paths) shortenWrap(path, boxes, paths.filter((p) => p !== path), direction);
    for (const path of paths) {
      if (path.points.length < 2) continue;
      // ELK ends a line on the room kept for a group name above a card. It goes on to the card.
      const onto = boxes.get(path.rel.to)!, tip = path.points.at(-1)!;
      if (onto.card?.lane && Math.abs(tip.y - (onto.y - LANE_CAP)) < 0.5) tip.y = onto.y;
      snap(path.points[0]!, boxes.get(path.rel.from)!);
      snap(path.points.at(-1)!, boxes.get(path.rel.to)!);
    }
    return paths.sort((a, b) => spec.relationships.indexOf(a.rel) - spec.relationships.indexOf(b.rel));
  };
  // ELK sizes a group from its children alone, and does not know about the label or the badge.
  // A group narrower than its label, or one whose label row has no place for the badge that is
  // clear of lines, is laid out again with that much more padding on the right.
  // (`elk.nodeSize.minimum` would do the first in one pass, but elkjs 0.12 swaps its width and
  // height on a group with children in a top-down layout.)
  const widen = new Map<string, number>();
  const roomed = new Set<string>();
  let done: any, paths: EdgePath[] = [];
  for (let pass = 0; pass < 5; pass++) {
    done = await run(widen);
    paths = read(done);
    let again = false;
    // Deepest first: a group that grows makes the groups around it grow too.
    const groups = [...boxes.values()].filter((g) => g.group).sort((a, z) => z.depth - a.depth);
    const gained = new Map<string | undefined, number>();
    for (const b of groups) {
      const inside = gained.get(b.el.id) ?? 0;
      const missing = Math.max(0, Math.ceil(groupMinWidth(b.el, b.light) - b.w - inside));
      if (missing > 0) { widen.set(b.el.id, (widen.get(b.el.id) ?? 0) + missing); again = true; }
      gained.set(b.el.parent, Math.max(gained.get(b.el.parent) ?? 0, inside + missing));
    }
    if (!again) {
      for (const b of groups) {
        const found = groupBadge(b, paths);
        if (!found || found.hits === 0 || roomed.has(b.el.id)) continue;
        roomed.add(b.el.id);
        widen.set(b.el.id, (widen.get(b.el.id) ?? 0) + found.rect.w + BADGE_GAP);
        again = true;
      }
    }
    if (!again) break;
  }
  let width: number = done.width ?? 0, height: number = done.height ?? 0;
  if (opts.wrap) {
    // A shortened line leaves the channel ELK kept for it at the edge of the drawing empty.
    const rects: Rect[] = [...boxes.values(), ...paths.flatMap((p) => [...p.points.map((q) => ({ x: q.x, y: q.y, w: 0, h: 0 })), ...(p.label ? [p.label] : [])])];
    const left = Math.min(...rects.map((r) => r.x)), top = Math.min(...rects.map((r) => r.y));
    width = Math.max(...rects.map((r) => r.x + r.w)) - left;
    height = Math.max(...rects.map((r) => r.y + r.h)) - top;
    for (const b of boxes.values()) { b.x -= left; b.y -= top; }
    for (const p of paths) {
      for (const q of p.points) { q.x -= left; q.y -= top; }
      if (p.label) { p.label.x -= left; p.label.y -= top; }
    }
  }
  for (const b of boxes.values()) b.badge = b.group ? groupBadge(b, paths)?.rect : leafBadge(b);
  // A wrap that cut nothing gives the same drawing as no wrap.
  const wrapped = Boolean(opts.wrap) && paths.some((p) => {
    const a = boxes.get(p.rel.from)!, z = boxes.get(p.rel.to)!;
    return a !== z && (direction === 'RIGHT' ? z.y >= a.y + a.h && z.x < a.x : z.x >= a.x + a.w && z.y < a.y);
  });
  return { width, height, nodes: [...boxes.values()], edges: paths, direction, numbered, compact, wrapped, flat };
}
