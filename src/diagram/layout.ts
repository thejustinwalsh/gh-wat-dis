import ELK from 'elkjs/lib/elk.bundled.js';
import type { Detail, DiagramSpec, SpecElement, SpecRelationship } from '../spec.ts';
import { textWidth, wrap } from './measure.ts';
import { STATUS_BADGE, STATUS_MARK, active, kindLine } from './vocab.ts';

export interface Pt { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }
export interface TextLine { text: string; cls: string; dy: number }
export interface NodeBox {
  el: SpecElement;
  group: boolean;
  depth: number;
  x: number; y: number; w: number; h: number;
  lines: TextLine[];
  /** Where the status badge is drawn. It lies inside the box, where no relationship line runs. */
  badge?: Rect;
}
export interface EdgeLabel extends Rect { lines: TextLine[] }
export interface EdgePath { rel: SpecRelationship; points: Pt[]; label?: EdgeLabel }
export interface Layout { width: number; height: number; nodes: NodeBox[]; edges: EdgePath[]; direction: 'DOWN' | 'RIGHT'; numbered: boolean; compact: boolean }
export interface LayoutOptions {
  detail?: Detail;
  direction?: 'DOWN' | 'RIGHT';
  numbered?: boolean;
  /** Target width / height. When set, ELK may wrap a long chain onto a second row or column. */
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
  if (!status) return undefined;
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

function edgeLabel(rel: SpecRelationship, num?: number): { w: number; h: number; lines: TextLine[] } {
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

/** The narrowest a group can be and still show its label on one line, with its badge beside it. */
export function groupMinWidth(el: SpecElement): number {
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
  const leaves = spec.elements.filter((e) => !parents.has(e.id) && e.type !== 'boundary' && e.type !== 'node').length;
  const compact = detail === 'compact' || (detail === 'auto' && leaves > FULL_DETAIL_MAX);
  const nodeW = compact && numbered ? NODE_W_FLOW : NODE_W;
  const ids = new Set(spec.elements.map((e) => e.id));
  const kids = new Map<string | undefined, SpecElement[]>();
  for (const el of spec.elements) {
    const key = el.parent !== undefined && ids.has(el.parent) ? el.parent : undefined;
    kids.set(key, [...(kids.get(key) ?? []), el]);
  }
  const common = {
    'elk.algorithm': 'layered',
    'elk.direction': direction,
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.layered.spacing.nodeNodeBetweenLayers': numbered ? '14' : compact ? '18' : '26',
    'elk.spacing.nodeNode': compact ? '20' : '26',
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
    const text = group ? { h: 64, lines: [] } : leafText(el, compact, nodeW);
    const emptyW = Math.max(160, groupMinWidth(el));
    boxes.set(el.id, { el, group, depth, x: 0, y: 0, w: group ? emptyW : nodeW, h: text.h, lines: text.lines });
    if (!group) return { id: el.id, width: nodeW, height: text.h };
    const below = new Set(seen).add(el.id);
    const side = compact ? 14 : 18;
    return {
      id: el.id,
      width: emptyW,
      height: 64,
      layoutOptions: {
        ...common,
        'elk.padding': `[top=${compact ? 38 : 46},left=${side},bottom=${side},right=${side + (widen.get(el.id) ?? 0)}]`,
      },
      children: children.map((c) => build(c, depth + 1, below, widen)),
    };
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
      return [{ id: `e${i}`, sources: [rel.from], targets: [rel.to], labels: [{ id: `l${i}`, text: rel.label, width: label.w + pad, height: label.h + pad, layoutOptions: { 'elk.edgeLabels.inline': 'true' } }] }];
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
        Object.assign(boxes.get(child.id)!, { x: child.x, y: child.y, w: child.width, h: child.height });
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
    for (const path of paths) {
      if (path.points.length < 2) continue;
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
      const missing = Math.max(0, Math.ceil(groupMinWidth(b.el) - b.w - inside));
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
  for (const b of boxes.values()) b.badge = b.group ? groupBadge(b, paths)?.rect : leafBadge(b);
  return { width: done.width ?? 0, height: done.height ?? 0, nodes: [...boxes.values()], edges: paths, direction, numbered, compact };
}
