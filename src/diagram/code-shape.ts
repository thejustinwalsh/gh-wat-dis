import type { DiagramSpec, SpecElement } from '../spec.ts';

/** A code diagram is this many layers of files, left to right. Three columns of cards are what the page holds. */
export const CODE_LAYERS = 3;
/** The tallest a layer of cards may be: the height of the page, less the title and the key. */
export const CODE_LAYER_HEIGHT = 1150;

/** About how tall the card of a file is with the gap under it, for sharing out layers before the cards are measured. */
export const cardHeight = (el: SpecElement): number =>
  42 + (el.parent === undefined ? 0 : 14) + (el.symbols?.length ? Math.min(8, el.symbols.length) * 20 + 9 : 0) + (el.description ? 20 : 0) + 14;

/** Where each file of a code diagram stands, worked out before the layout engine runs. */
export interface CodeShape {
  /** The layer of each file, from 0 at the left. A file imports only from its own layer and the ones to its right. */
  layer: Map<string, number>;
  /** How many layers are drawn: at most `CODE_LAYERS`. */
  layers: number;
  /** How many layers the imports would need with no limit. Past `CODE_LAYERS` the chain is too deep for one diagram. */
  depth: number;
  /** Files that belong in a layer past the three drawn, and stand in the nearest one instead. */
  beyond: string[];
  /** The height of each layer: its cards and the gaps between them. */
  heights: number[];
}

const changed = (status: string | undefined): boolean => status === 'added' || status === 'changed' || status === 'removed';

/**
 * The shape of a code diagram: files in layers by import depth, so that every line runs from
 * left to right or stays inside one layer. Files that import one another in a cycle share a layer.
 * A file with nothing to its left moves right until it stands beside what it imports.
 *
 * When the imports are more than three layers deep, the three layers that hold the first file and
 * the most changed files are drawn, and a file from a layer further out stands in the nearest of the three.
 * `graph from-facts` cuts those files instead, and lint names them in a hand-written spec.
 * A file with no line at all stands in the shortest layer.
 */
export function codeShape(spec: DiagramSpec, height: (el: SpecElement) => number = cardHeight): CodeShape {
  const parents = new Set(spec.elements.map((e) => e.parent));
  const files = spec.elements.filter((e) => !parents.has(e.id) && e.type !== 'boundary' && e.type !== 'node');
  const ids = new Set(files.map((f) => f.id));
  const out = new Map<string, Set<string>>(files.map((f) => [f.id, new Set()]));
  const joined = new Set<string>();
  for (const r of spec.relationships) if (r.from !== r.to && ids.has(r.from) && ids.has(r.to)) { out.get(r.from)!.add(r.to); joined.add(r.from).add(r.to); }

  // Files that import one another in a cycle are one knot (Tarjan). `knots` comes out with each knot after the ones it imports.
  const index = new Map<string, number>(), low = new Map<string, number>(), knot = new Map<string, number>();
  const stack: string[] = [], knots: string[][] = [];
  const visit = (id: string): void => {
    index.set(id, index.size);
    low.set(id, index.get(id)!);
    stack.push(id);
    for (const to of out.get(id)!) {
      if (!index.has(to)) { visit(to); low.set(id, Math.min(low.get(id)!, low.get(to)!)); }
      else if (!knot.has(to)) low.set(id, Math.min(low.get(id)!, index.get(to)!));
    }
    if (low.get(id) !== index.get(id)) return;
    const members: string[] = [];
    for (let top = ''; top !== id;) { top = stack.pop()!; knot.set(top, knots.length); members.push(top); }
    knots.push(members);
  };
  for (const f of files) if (!index.has(f.id)) visit(f.id);

  // Depth: one more than the deepest importer. Then a file moves right, as far as the files it imports allow.
  const depthOf = new Array<number>(knots.length).fill(0);
  const imports = (k: number): number[] => [...new Set(knots[k]!.flatMap((id) => [...out.get(id)!].map((to) => knot.get(to)!)).filter((j) => j !== k))];
  for (let k = knots.length - 1; k >= 0; k--) for (const j of imports(k)) depthOf[j] = Math.max(depthOf[j]!, depthOf[k]! + 1);
  for (let k = 0; k < knots.length; k++) { const to = imports(k); if (to.length) depthOf[k] = Math.max(depthOf[k]!, Math.min(...to.map((j) => depthOf[j]!)) - 1); }
  const depth = joined.size ? Math.max(...files.filter((f) => joined.has(f.id)).map((f) => depthOf[knot.get(f.id)!]!)) + 1 : 0;

  // More than three deep: keep the three layers in a row that hold the first file of the spec, which is the one the
  // diagram is about, and then the changed files listed soonest: a spec lists the files with the most change first.
  let first = 0;
  if (depth > CODE_LAYERS) {
    const weight = (start: number): number => files.filter((f) => depthOf[knot.get(f.id)!]! >= start && depthOf[knot.get(f.id)!]! < start + CODE_LAYERS)
      .reduce((sum, f) => sum + (f === files[0] ? files.length ** 2 : 0) + (changed(f.status) ? files.length - files.indexOf(f) : 0), 0);
    for (let start = 1; start + CODE_LAYERS <= depth; start++) if (weight(start) > weight(first)) first = start;
  }
  const layers = Math.max(1, Math.min(depth, CODE_LAYERS));
  const layer = new Map<string, number>(), beyond: string[] = [], heights = new Array<number>(layers).fill(0);
  for (const f of files.filter((x) => joined.has(x.id))) {
    const d = depthOf[knot.get(f.id)!]! - first;
    if (d < 0 || d >= CODE_LAYERS) beyond.push(f.id);
    layer.set(f.id, Math.max(0, Math.min(CODE_LAYERS - 1, d)));
    heights[layer.get(f.id)!]! += height(f);
  }
  for (const f of files.filter((x) => !joined.has(x.id))) {
    const least = heights.indexOf(Math.min(...heights));
    layer.set(f.id, least);
    heights[least]! += height(f);
  }
  return { layer, layers, depth, beyond, heights };
}
