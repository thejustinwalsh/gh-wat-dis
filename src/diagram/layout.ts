import ELK from 'elkjs/lib/elk.bundled.js';
import type { DiagramSpec, SpecElement, SpecRelationship } from '../spec.ts';
import { textWidth, wrap } from './measure.ts';
import { STATUS_BADGE, STATUS_MARK, active, kindLine } from './vocab.ts';

export interface Pt { x: number; y: number }
export interface TextLine { text: string; cls: string; dy: number }
export interface NodeBox {
  el: SpecElement;
  group: boolean;
  depth: number;
  x: number; y: number; w: number; h: number;
  lines: TextLine[];
}
export interface EdgeLabel { x: number; y: number; w: number; h: number; lines: TextLine[] }
export interface EdgePath { rel: SpecRelationship; points: Pt[]; label?: EdgeLabel }
export interface Layout { width: number; height: number; nodes: NodeBox[]; edges: EdgePath[] }

export const NODE_W = 208;
export const CYLINDER_RY = 8;
export const PIPE_RX = 11;
export const GROUP_NAME_PX = 13;
export const GROUP_KIND_PX = 10.5;
export const BADGE_PX = 9.5;
const PAD_X = 14;
const LABEL_MAX = 150;
const TOP_INSET: Record<string, number> = { person: 40, datastore: 2 * CYLINDER_RY + 8 };

export const badgeWidth = (status: string): number => textWidth(STATUS_BADGE[status] ?? '', BADGE_PX, true) + 14;

function leafText(el: SpecElement): { h: number; lines: TextLine[] } {
  const inner = NODE_W - 2 * PAD_X - (el.type === 'queue' ? 2 * PIPE_RX : 0);
  const lines: TextLine[] = [];
  let y = TOP_INSET[el.type] ?? 14;
  const add = (texts: string[], cls: string, lineHeight: number, ascent: number): void => {
    for (const text of texts) { lines.push({ text, cls, dy: y + ascent }); y += lineHeight; }
  };
  add(wrap(el.name, 14, inner, true), 'nm', 18, 13.5);
  y += 1;
  add(wrap(kindLine(el), 11, inner), 'ty', 14, 10.5);
  if (el.description) { y += 6; add(wrap(el.description, 12, inner), 'ds', 16, 11.5); }
  return { h: Math.ceil(y + (el.type === 'datastore' ? CYLINDER_RY + 8 : 13)), lines };
}

function edgeLabel(rel: SpecRelationship): { w: number; h: number; lines: TextLine[] } {
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

/** Width of an empty group. ELK sizes a group with children from the children alone, so svg.ts fits the label to it. */
const emptyGroupWidth = (el: SpecElement): number =>
  Math.ceil(Math.max(160, textWidth(el.name, GROUP_NAME_PX, true) + 8 + textWidth(kindLine(el), GROUP_KIND_PX) + 30));

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

export async function layout(spec: DiagramSpec): Promise<Layout> {
  const direction = spec.direction === 'RIGHT' ? 'RIGHT' : 'DOWN';
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
    'elk.layered.spacing.nodeNodeBetweenLayers': '26',
    'elk.spacing.nodeNode': '26',
    'elk.spacing.edgeNode': '18',
    'elk.spacing.edgeEdge': '14',
    'elk.spacing.edgeLabel': '5',
    'elk.spacing.labelLabel': '6',
    'elk.layered.spacing.edgeNodeBetweenLayers': '20',
    'elk.layered.spacing.edgeEdgeBetweenLayers': '12',
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.mergeEdges': 'false',
  };
  const boxes = new Map<string, NodeBox>();
  // elkjs takes and returns plain JSON, so the graph is untyped at this boundary.
  const build = (el: SpecElement, depth: number, seen: Set<string>): any => {
    const children = seen.has(el.id) ? [] : (kids.get(el.id) ?? []);
    const group = children.length > 0 || el.type === 'boundary' || el.type === 'node';
    const text = group ? { h: 64, lines: [] } : leafText(el);
    boxes.set(el.id, { el, group, depth, x: 0, y: 0, w: group ? emptyGroupWidth(el) : NODE_W, h: text.h, lines: text.lines });
    if (!group) return { id: el.id, width: NODE_W, height: text.h };
    const below = new Set(seen).add(el.id);
    return {
      id: el.id,
      width: emptyGroupWidth(el),
      height: 64,
      layoutOptions: {
        ...common,
        'elk.padding': '[top=46,left=18,bottom=18,right=18]',
      },
      children: children.map((c) => build(c, depth + 1, below)),
    };
  };
  const children = (kids.get(undefined) ?? []).map((el) => build(el, 0, new Set()));
  const labels = new Map<number, ReturnType<typeof edgeLabel>>();
  const edges = spec.relationships.flatMap((rel, i) => {
    if (!boxes.has(rel.from) || !boxes.has(rel.to)) return [];
    const label = edgeLabel(rel);
    labels.set(i, label);
    return [{ id: `e${i}`, sources: [rel.from], targets: [rel.to], labels: [{ id: `l${i}`, text: rel.label, width: label.w, height: label.h, layoutOptions: { 'elk.edgeLabels.inline': 'true' } }] }];
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
  const elk = new (ELK as any)();
  const done: any = await elk.layout(graph(true)).catch(() => elk.layout(graph(false)));

  const paths: EdgePath[] = [];
  const walk = (node: any): void => {
    for (const child of node.children ?? []) {
      Object.assign(boxes.get(child.id)!, { x: child.x, y: child.y, w: child.width, h: child.height });
      walk(child);
    }
    for (const edge of node.edges ?? []) {
      const i = Number(String(edge.id).slice(1));
      const rel = spec.relationships[i]!;
      const points: Pt[] = (edge.sections ?? []).flatMap((s: any) => [s.startPoint, ...(s.bendPoints ?? []), s.endPoint])
        .map((p: Pt) => ({ x: p.x, y: p.y }));
      const placed = edge.labels?.[0];
      const label = labels.get(i)!;
      paths.push({ rel, points, label: placed ? { x: placed.x, y: placed.y, w: label.w, h: label.h, lines: label.lines } : undefined });
    }
  };
  walk(done);
  for (const path of paths) {
    if (path.points.length < 2) continue;
    snap(path.points[0]!, boxes.get(path.rel.from)!);
    snap(path.points.at(-1)!, boxes.get(path.rel.to)!);
  }
  paths.sort((a, b) => spec.relationships.indexOf(a.rel) - spec.relationships.indexOf(b.rel));
  return { width: done.width ?? 0, height: done.height ?? 0, nodes: [...boxes.values()], edges: paths };
}
