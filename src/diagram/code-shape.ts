import type { DiagramSpec, SpecElement } from '../spec.ts';

/** A code diagram is this many layers of files, left to right. Three columns of cards are what the page holds. */
export const CODE_LAYERS = 3;
/** The tallest a layer of cards may be: the height of the page, less the title and the key. */
export const CODE_LAYER_HEIGHT = 1150;
/** Past this many files a knot is put in order greedily: the exact order costs 2^n steps. */
const EXACT_ORDER = 12;

/** About how tall the card of a file is with the gap under it, for sharing out layers before the cards are measured. */
export const cardHeight = (el: SpecElement): number =>
  42 + (el.parent === undefined ? 0 : 14) + (el.symbols?.length ? Math.min(8, el.symbols.length) * 20 + 9 : 0) + (el.description ? 20 : 0) + 14;

/** Where each file of a code diagram stands, worked out before the layout engine runs. */
export interface CodeShape {
  /** The layer of each file, from 0 at the left. A file imports from its own layer and the ones to its right, except along a knot. */
  layer: Map<string, number>;
  /** How many layers are drawn: at most `CODE_LAYERS`. */
  layers: number;
  /** How many layers the imports would need with no limit. Past `CODE_LAYERS` the chain is too deep for one diagram. */
  depth: number;
  /** Files that belong in a layer past the three drawn, and stand in the nearest one instead. */
  beyond: string[];
  /** The height of each layer: its cards and the gaps between them. */
  heights: number[];
  /** How deep each file stands in the chain, before the layers past the three are folded in: the order inside a layer that holds several. */
  rank: Map<string, number>;
}

const changed = (status: string | undefined): boolean => status === 'added' || status === 'changed' || status === 'removed';

/**
 * The order of the files of a knot, importer before imported, that leaves the fewest imports running back
 * against it: each import counted as often as the spec draws it. Of orders that tie, the one nearest the
 * order of the spec wins, and a spec lists the files with the most change first.
 */
export function knotOrder(members: string[], weight: (from: string, to: string) => number, listed: (id: string) => number): string[] {
  const ids = [...members].sort((a, b) => listed(a) - listed(b));
  const n = ids.length;
  /** What placing `v` after the files already placed costs: its imports of them run back. */
  const cost = (v: number, placed: (u: number) => boolean): number => ids.reduce((sum, u, k) => sum + (k !== v && placed(k) ? weight(ids[v]!, u) : 0), 0);
  if (n > EXACT_ORDER) {
    const out: number[] = [];
    while (out.length < n) {
      let best = -1, least = Infinity;
      for (let v = 0; v < n; v++) if (!out.includes(v)) { const c = cost(v, (u) => out.includes(u)); if (c < least) { least = c; best = v; } }
      out.push(best);
    }
    return out.map((k) => ids[k]!);
  }
  // rest[mask]: the least back weight for ordering the files not in `mask`, once the files in it are placed.
  const full = (1 << n) - 1;
  const rest = new Float64Array(1 << n).fill(Infinity);
  rest[full] = 0;
  for (let mask = full - 1; mask >= 0; mask--) {
    for (let v = 0; v < n; v++) if (!(mask & (1 << v))) rest[mask] = Math.min(rest[mask]!, cost(v, (u) => (mask & (1 << u)) !== 0) + rest[mask | (1 << v)]!);
  }
  const out: string[] = [];
  for (let mask = 0; mask !== full;) {
    for (let v = 0; v < n; v++) {
      if (mask & (1 << v)) continue;
      if (cost(v, (u) => (mask & (1 << u)) !== 0) + rest[mask | (1 << v)]! === rest[mask]) { out.push(ids[v]!); mask |= 1 << v; break; }
    }
  }
  return out;
}

/**
 * The shape of a code diagram: files in layers by import depth, so that every line runs from
 * left to right or stays inside one layer.
 *
 * Files that import one another in a cycle are a knot, and a knot still has an order: the one that
 * leaves the fewest imports running back (`knotOrder`). When there are layers to spare within the
 * three, the knot is spread over them in that order, so its imports run between layers as any other
 * import does and only the few that run back are drawn right to left. With no layer to spare it shares one.
 * A file with nothing to its left moves right until it stands beside what it imports.
 *
 * When the imports are more than three layers deep, the three layers that hold the most change are drawn, and a file from a layer further out stands in the nearest of the three.
 * `graph from-facts` cuts those files instead, and lint names them in a hand-written spec.
 * A file with no line at all stands in the shortest layer.
 *
 * `spread` false keeps each knot in one layer: the budget of the other diagrams counts a cycle as one step of a chain.
 * `start` tries another leading member when minimum-back-weight orders tie.
 */
export function codeShape(spec: DiagramSpec, height: (el: SpecElement) => number = cardHeight, limit = CODE_LAYERS, spread = true, start = 0): CodeShape {
  const parents = new Set(spec.elements.map((e) => e.parent));
  const files = spec.elements.filter((e) => !parents.has(e.id) && e.type !== 'boundary' && e.type !== 'node');
  const ids = new Set(files.map((f) => f.id));
  const listed = new Map(files.map((f, i) => [f.id, i]));
  const out = new Map<string, Set<string>>(files.map((f) => [f.id, new Set()]));
  const weights = new Map<string, number>();
  const joined = new Set<string>();
  for (const r of spec.relationships) {
    if (r.from === r.to || !ids.has(r.from) || !ids.has(r.to)) continue;
    out.get(r.from)!.add(r.to);
    joined.add(r.from).add(r.to);
    weights.set(`${r.from}\0${r.to}`, (weights.get(`${r.from}\0${r.to}`) ?? 0) + 1);
  }
  const weight = (a: string, b: string): number => weights.get(`${a}\0${b}`) ?? 0;

  // Files that import one another in a cycle are one knot (Tarjan). `knots` comes out with each knot after the ones it imports.
  const index = new Map<string, number>(), low = new Map<string, number>(), knotOf = new Map<string, number>();
  const stack: string[] = [], knots: string[][] = [];
  const visit = (id: string): void => {
    index.set(id, index.size);
    low.set(id, index.get(id)!);
    stack.push(id);
    for (const to of out.get(id)!) {
      if (!index.has(to)) { visit(to); low.set(id, Math.min(low.get(id)!, low.get(to)!)); }
      else if (!knotOf.has(to)) low.set(id, Math.min(low.get(id)!, index.get(to)!));
    }
    if (low.get(id) !== index.get(id)) return;
    const members: string[] = [];
    for (let top = ''; top !== id;) { top = stack.pop()!; knotOf.set(top, knots.length); members.push(top); }
    // Equal back weights can give different routes. A candidate may lead with another member,
    // keeping the remaining members in spec order; knotOrder still minimizes the back weight.
    const order = [...members].sort((a, b) => listed.get(a)! - listed.get(b)!);
    const lead = order[start % order.length]!;
    knots.push(knotOrder(members, weight, (m) => m === lead ? -1 : listed.get(m)!));
  };
  for (const f of files) if (!index.has(f.id)) visit(f.id);

  /**
   * Blocks stand in layers: a file, or a run of a knot in its order. Each block comes after the blocks it imports.
   * `runs[k]` cuts knot k into that many runs, as even in height as its order allows.
   */
  const cut = (k: number, n: number): string[][] => {
    const order = knots[k]!;
    if (n <= 1) return [order];
    const h = order.map((id) => height(spec.elements.find((e) => e.id === id)!));
    // Every way to cut the order into n runs, scored by imports inside a run (drawn beside the cards), then imports that
    // run back across runs (each one more for each run it crosses), then the tallest run.
    let best: string[][] = [order], score = [Infinity];
    const at = (ends: number[]): string[][] => ends.map((end, j) => order.slice(j ? ends[j - 1] : 0, end));
    const runOf = new Map<string, number>();
    const walk = (from: number, left: number, ends: number[]): void => {
      if (left === 1) {
        const all = [...ends, order.length];
        const runs = at(all);
        runs.forEach((r, j) => { for (const id of r) runOf.set(id, j); });
        let inside = 0, back = 0;
        for (const a of order) for (const b of order) {
          const w = weight(a, b);
          if (!w) continue;
          if (runOf.get(a) === runOf.get(b)) inside += w;
          else if (runOf.get(a)! > runOf.get(b)!) back += w * (runOf.get(a)! - runOf.get(b)!);
        }
        const tallest = Math.max(...runs.map((r) => r.reduce((s, id) => s + h[order.indexOf(id)]!, 0)));
        const s = [Math.max(0, tallest - CODE_LAYER_HEIGHT), back + inside, tallest];
        const differ = s.findIndex((v, i) => v !== score[i]);
        if (differ >= 0 && s[differ]! < score[differ]!) { best = runs; score = s; }
        return;
      }
      for (let end = from + 1; end <= order.length - (left - 1); end++) walk(end, left - 1, [...ends, end]);
    };
    walk(0, n, []);
    return best;
  };

  const layOut = (runs: number[]): { blocks: string[][]; blockOf: Map<string, number>; depthOf: number[]; depth: number } => {
    const blocks: string[][] = [];
    const blockOf = new Map<string, number>();
    // A knot's runs go in from the last, so that each comes after the runs it imports.
    knots.forEach((_, k) => { for (const run of cut(k, runs[k]!).reverse()) { for (const id of run) blockOf.set(id, blocks.length); blocks.push(run); } });
    const imports = (b: number): number[] => {
      const to = new Set<number>();
      for (const id of blocks[b]!) for (const t of out.get(id)!) if (blockOf.get(t)! < b) to.add(blockOf.get(t)!);
      // The runs of one knot stay in their order even where no import joins two of them.
      const next = b - 1;
      if (next >= 0 && knotOf.get(blocks[next]![0]!) === knotOf.get(blocks[b]![0]!)) to.add(next);
      return [...to];
    };
    // Depth: one more than the deepest importer. Then a block moves right, as far as the blocks it imports allow.
    const depthOf = new Array<number>(blocks.length).fill(0);
    for (let b = blocks.length - 1; b >= 0; b--) for (const j of imports(b)) depthOf[j] = Math.max(depthOf[j]!, depthOf[b]! + 1);
    for (let b = 0; b < blocks.length; b++) { const to = imports(b); if (to.length) depthOf[b] = Math.max(depthOf[b]!, Math.min(...to.map((j) => depthOf[j]!)) - 1); }
    const depth = joined.size ? Math.max(...files.filter((f) => joined.has(f.id)).map((f) => depthOf[blockOf.get(f.id)!]!)) + 1 : 0;
    return { blocks, blockOf, depthOf, depth };
  };

  // A knot is spread over the layers there are to spare, the largest knot first, as long as the whole stays within the limit.
  const runs = knots.map(() => 1);
  if (spread) {
    const room = Math.max(layOut(runs).depth, limit);
    for (const k of knots.map((_, k) => k).sort((a, b) => knots[b]!.length - knots[a]!.length)) {
      if (knots[k]!.length < 2) break;
      for (let n = Math.min(knots[k]!.length, limit); n > 1; n--) {
        runs[k] = n;
        if (layOut(runs).depth <= room) break;
        runs[k] = 1;
      }
    }
  }
  const { blockOf, depthOf, depth } = layOut(runs);
  const depthOfFile = (id: string): number => depthOf[blockOf.get(id)!]!;

  // More than three deep: keep the three layers in a row that hold the most change, always with the first file in them.
  // A spec lists the files with the most change first, so a changed file counts more the sooner it is listed.
  let first = 0;
  if (depth > limit) {
    const weightAt = (start: number): number => files.filter((f) => depthOfFile(f.id) >= start && depthOfFile(f.id) < start + limit)
      .reduce((sum, f) => sum + (changed(f.status) ? files.length - files.indexOf(f) : 0), 0);
    const lead = files.find((f) => joined.has(f.id));
    const at = lead ? depthOfFile(lead.id) : 0;
    const lo = Math.max(0, at - limit + 1), high = Math.min(at, depth - limit);
    first = lo;
    for (let start = lo + 1; start <= high; start++) if (weightAt(start) > weightAt(first)) first = start;
  }
  const layers = Math.max(1, Math.min(depth, limit));
  const layer = new Map<string, number>(), beyond: string[] = [], heights = new Array<number>(layers).fill(0), rank = new Map<string, number>();
  for (const f of files.filter((x) => joined.has(x.id))) {
    const d = depthOfFile(f.id) - first;
    rank.set(f.id, d);
    if (d < 0 || d >= limit) beyond.push(f.id);
    layer.set(f.id, Math.max(0, Math.min(limit - 1, d)));
    heights[layer.get(f.id)!]! += height(f);
  }
  for (const f of files.filter((x) => !joined.has(x.id))) {
    const least = heights.indexOf(Math.min(...heights));
    layer.set(f.id, least);
    heights[least]! += height(f);
  }
  return { layer, layers, depth, beyond, heights, rank };
}
