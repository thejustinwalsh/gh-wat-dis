// The regression harness for the layout stage. It draws every spec of the corpus, checks the gates on
// the geometry of what was drawn, and compares the rung and the size with a table, so that a change
// which moves a drawing shows up as a diff of test/fixtures/layout-expected.json.
// To accept new results: UPDATE_LAYOUT=1 node --test test/layout.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lintSpec, render } from '../src/diagram/index.ts';
import { MAX_WIDTH } from '../src/diagram/fit.ts';
import { GOLDEN, measure, failed } from '../src/diagram/judge.ts';
import { BREADTH_BUDGET, BUDGET } from '../src/diagram/budget.ts';
import { CARD_ROW } from '../src/diagram/layout.ts';
import type { Layout, NodeBox, Pt, Rect } from '../src/diagram/layout.ts';
import type { DiagramSpec } from '../src/spec.ts';

const dir = (name: string): string => fileURLToPath(new URL(name, import.meta.url));
const specs: [string, DiagramSpec][] = [];
for (const [folder, prefix] of [['../examples/diagrams/', 'example/'], ['./fixtures/', 'fixture/'], ['./fixtures/pressure/', ''], ['./fixtures/corpus/', '']] as const) {
  for (const file of readdirSync(dir(folder)).filter((f) => f.endsWith('.json') && f !== 'layout-expected.json').sort()) {
    specs.push([prefix + file.replace(/\.json$/, ''), JSON.parse(readFileSync(dir(folder + file), 'utf8')) as DiagramSpec]);
  }
}
const EXPECTED = dir('./fixtures/layout-expected.json');

/** True when a segment of the line runs inside the rectangle, `inset` pixels in from its border. */
const hits = (points: Pt[], r: Rect, inset = 1): boolean => points.some((b, i) => {
  if (i === 0) return false;
  const a = points[i - 1]!;
  return Math.max(a.x, b.x) > r.x + inset && Math.min(a.x, b.x) < r.x + r.w - inset && Math.max(a.y, b.y) > r.y + inset && Math.min(a.y, b.y) < r.y + r.h - inset;
});
/** True when the point is on the border of the box: on a side level with the named row for a file, anywhere on the border otherwise. */
function onBorder(p: Pt, b: NodeBox, symbol: string | undefined): boolean {
  const slack = b.el.type === 'datastore' || b.el.type === 'queue' ? 14 : 2.5;
  const inX = p.x >= b.x - slack && p.x <= b.x + b.w + slack, inY = p.y >= b.y - slack && p.y <= b.y + b.h + slack;
  const side = inY && (Math.abs(p.x - b.x) <= slack || Math.abs(p.x - b.x - b.w) <= slack);
  if (!b.card) return side || (inX && (Math.abs(p.y - b.y) <= slack || Math.abs(p.y - b.y - b.h) <= slack));
  const index = symbol === undefined ? -1 : (b.el.symbols ?? []).findIndex((s) => s.name === symbol);
  const row = b.card.rows[index];
  return side && (row ? Math.abs(p.y - (b.y + row.dy)) <= CARD_ROW / 2 + 1 : p.y <= b.y + b.card.head + 1);
}

/** The gates that hold for every drawing, checked on the geometry alone. Returns what is wrong, in words. */
function gateFaults(spec: DiagramSpec, l: Layout): string[] {
  const out: string[] = [];
  const box = new Map(l.nodes.map((b) => [b.el.id, b]));
  const drawable = spec.relationships.filter((r) => box.has(r.from) && box.has(r.to));
  const drawn = l.edges.filter((e) => e.points.length > 1);
  if (drawn.length !== drawable.length) out.push(`${drawn.length} lines for ${drawable.length} relationships`);
  const holds = (group: NodeBox, id: string): boolean => {
    for (let b = box.get(id), n = 0; b && n < 50; b = b.el.parent !== undefined ? box.get(b.el.parent) : undefined, n++) if (b === group) return true;
    return false;
  };
  for (const e of drawn) {
    const name = `${e.rel.from} -> ${e.rel.to}`;
    if (!onBorder(e.points[0]!, box.get(e.rel.from)!, e.rel.fromSymbol)) out.push(`${name} does not start on its element or row`);
    if (!onBorder(e.points.at(-1)!, box.get(e.rel.to)!, e.rel.toSymbol)) out.push(`${name} does not end on its element or row`);
    for (const b of l.nodes) {
      if (b.title && hits(e.points, b.title, 0)) out.push(`${name} runs through the name of ${b.el.id}`);
      if (b.badge && hits(e.points, b.badge, 0)) out.push(`${name} runs through the badge of ${b.el.id}`);
      if (b.el.id !== e.rel.from && b.el.id !== e.rel.to && !(b.group && (holds(b, e.rel.from) || holds(b, e.rel.to))) && hits(e.points, b, 2)) out.push(`${name} runs through ${b.el.id}`);
    }
    for (const o of drawn) if (o !== e && o.label && hits(e.points, o.label, 2)) out.push(`${name} runs through the label of ${o.rel.from} -> ${o.rel.to}`);
  }
  for (const b of l.nodes) {
    if (b.title && (b.title.x < b.x - 1 || b.title.x + b.title.w > b.x + b.w + 1 || b.title.y < b.y - 1 || b.title.y + b.title.h > b.y + b.h + 1)) out.push(`the name of ${b.el.id} is not inside it`);
    // No two boxes that are not one inside the other overlap.
    for (const o of l.nodes) {
      if (o === b || b.group || o.group) continue;
      if (b.x < o.x + o.w - 1 && o.x < b.x + b.w - 1 && b.y < o.y + o.h - 1 && o.y < b.y + b.h - 1 && b.el.id < o.el.id) out.push(`${b.el.id} overlaps ${o.el.id}`);
    }
  }
  return out;
}

test('layout corpus: every drawing passes the gates on its geometry, and its rung and size match the table', async () => {
  const table: Record<string, string> = {};
  for (const [name, spec] of specs) {
    if (lintSpec(spec).errors.length) continue;
    const out = await render(spec);
    const kept = out.report.candidates.find((c) => c.chosen)!;
    const l = out.layout;
    assert.deepEqual(gateFaults(spec, l), [], name);
    // What the judge says of its own choice agrees with the geometry.
    assert.deepEqual(kept.fails.filter((g) => g !== 'width' && g !== 'height' && g !== 'calm'), [], `${name}: ${out.report.why}`);
    assert.equal(kept.fails.includes('width'), out.width > MAX_WIDTH, name);
    assert.equal(kept.fails.includes('height'), out.height > Math.round(MAX_WIDTH * GOLDEN), name);
    assert.equal(out.report.passed, kept.fails.length === 0, name);
    assert.equal(kept.calmCrossings, kept.crossings, `${name}: calm must count every crossing`);
    table[name] = `${out.report.passed ? `rung ${out.report.rung} of ${out.report.rungs}` : `no rung of ${out.report.rungs}: ${kept.fails.join(', ')}`} | ${out.width} x ${out.height} | ${out.direction === 'RIGHT' ? 'left to right' : 'top down'}${out.numbered ? ', numbered' : ''}${kept.wrapped ? ', wrapped' : ''}`;
  }
  if (process.env.UPDATE_LAYOUT) writeFileSync(EXPECTED, JSON.stringify(table, null, 2) + '\n');
  assert.deepEqual(table, JSON.parse(readFileSync(EXPECTED, 'utf8')), 'a drawing moved: look at it, then run UPDATE_LAYOUT=1 node --test test/layout.test.ts');
});

test('code calm: in-layer lines and loops count, and four-file knots improve without hiding crossings', async () => {
  const { layout } = await import('../src/diagram/layout.ts');
  const named = new Map(specs);
  const crowded = await layout(named.get('knot4-all')!, { direction: 'RIGHT', whole: true });
  assert.ok(crowded.edges.some((e) => e.inLayer));
  const before = measure(crowded);
  assert.equal(before.crossings, 15);
  assert.equal(before.calmCrossings, before.crossings);
  assert.ok(failed(before, { width: 497, height: 516 }, { width: 860, height: 1376 }).includes('calm'));

  // A loop crosses a different line twice. It is counted even though it never changes layers.
  const node = (id: string, x: number, y: number): NodeBox => ({ el: { id, type: 'file', name: id }, x, y, w: 20, h: 20, group: false, depth: 0, lines: [] });
  const loop: Layout = {
    width: 120, height: 50, direction: 'RIGHT', numbered: false, compact: false, layered: true, wrapped: false,
    nodes: [node('a', 0, 0), node('b', 100, 0), node('c', 100, 30)],
    edges: [
      { rel: { from: 'a', to: 'a', label: '' }, points: [{ x: 20, y: 5 }, { x: 60, y: 5 }, { x: 60, y: 15 }, { x: 20, y: 15 }] },
      { rel: { from: 'b', to: 'c', label: '' }, points: [{ x: 100, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 100, y: 30 }] },
    ],
  };
  const loopMetrics = measure(loop);
  assert.deepEqual([loopMetrics.broken, loopMetrics.crossings, loopMetrics.calmCrossings, loopMetrics.calmAllowed], [0, 2, 2, 1]);
  assert.ok(failed(loopMetrics, loop, { width: 860, height: 1376 }).includes('calm'));

  for (const name of ['knot4-all', 'knot4-hub']) {
    const out = await render(named.get(name)!);
    const kept = out.report.candidates.find((c) => c.chosen)!;
    assert.equal(out.report.passed, true, name);
    assert.ok(kept.crossings <= 2, `${name}: ${kept.crossings} crossings`);
    assert.equal(kept.calmCrossings, kept.crossings, name);
    assert.deepEqual(out.report.warnings, [], name);
    assert.equal(out.layout.edges.length, named.get(name)!.relationships.length, 'every import stays drawn');
    assert.deepEqual(gateFaults(named.get(name)!, out.layout), [], name);
  }
});

test('shape from structure: trees wrap without crossings, groups stay whole, knots spread over layers', async () => {
  const { render: draw } = await import('../src/diagram/svg.ts');
  const { advise } = await import('../src/diagram/advise.ts');
  const named = new Map(specs);
  // Each of these draws inside every gate. A tree's lines back to the next row nest, so they cross nothing.
  const pass = ['n24-tree15', 'tree15-right', 'tree-deep-right', 'tree-deep', 'tree-wide', 'wide-right-named', 'groups3-chain', 'groups3-chain-right',
    'knot4-hub', 'knot4-all', 'knot6-ring', 'knot6-hub', 'knot8-ring', 'knot8-hub'];
  for (const name of pass) {
    const out = await draw(named.get(name)!);
    const kept = out.report.candidates.find((c) => c.chosen)!;
    assert.ok(out.report.passed, `${name}: ${out.report.why}`);
    if (name.includes('tree')) assert.equal(kept.crossings, 0, `${name}: ${kept.crossings} crossings`);
  }
  // A wrap never cuts a group: each group is drawn whole on one row, and its boxes stay inside it.
  for (const name of ['wide-right-named', 'groups3-chain-right']) {
    const l = (await draw(named.get(name)!)).layout;
    for (const g of l.nodes.filter((b) => b.group)) {
      for (const b of l.nodes.filter((x) => x.el.parent === g.el.id)) assert.ok(b.x >= g.x && b.y >= g.y && b.x + b.w <= g.x + g.w && b.y + b.h <= g.y + g.h, `${name}: ${b.el.id} outside ${g.el.id}`);
    }
  }
  // A chain inside one group, forced left to right, cannot wrap: the group is one piece. The drawing says so and the
  // fix is to leave the direction to the type.
  const one = { ...named.get('wide-right-one-group')!, direction: 'RIGHT' as const };
  const forced = await draw(one);
  assert.equal(forced.report.passed, false);
  assert.ok(forced.report.candidates.every((c) => !c.wrapped), 'a wrap cut the group');
  const fixes = (await advise(one, {}, forced.report)).fixes;
  assert.deepEqual(fixes.map((f) => [f.command, f.warnings]), [['graph set --direction ""', []]]);
  // A group whose name is wider than the page holds its boxes in one piece too, so it does not wrap. Shortening the name is
  // the fix, and it was drawn first.
  const long = named.get('n21-long-group-names')!;
  const wide = await draw(long);
  assert.equal(wide.report.passed, false);
  const shorten = (await advise(long, {}, wide.report)).fixes[0]!;
  assert.match(shorten.command, /^shorten the group names/);
  assert.ok(shorten.width <= 860, `${shorten.width}`);
  // This ring exceeds the code budget (12 lines). Its eight crossings used to pass only because
  // the calm gate ignored the six inside its layers. Keep its geometry, but report the failed gate.
  const dense = await draw(named.get('11-code8x6')!);
  const denseKept = dense.report.candidates.find((c) => c.chosen)!;
  assert.equal(dense.report.passed, false);
  assert.deepEqual(denseKept.fails, ['calm']);
  assert.equal(denseKept.calmCrossings, denseKept.crossings);
  assert.ok(denseKept.crossings > denseKept.calmAllowed);
  // Eight files in a ring are spread over three layers instead of one tall column.
  const ring = (await draw(named.get('11-code8x6')!)).layout;
  assert.equal(new Set(ring.nodes.map((b) => Math.round(b.x))).size, 3);
});

/**
 * Specs at the edge of each type's budget, made up from a seed: a chain of a given depth, at most four elements side
 * by side at each step, each joined to one before it, and then more lines between neighbouring steps until the line
 * budget is used. A code diagram is three steps deep, as its budget says.
 */
function atBudget(type: DiagramSpec['type'], depth: number, seed: number): DiagramSpec {
  let state = seed;
  const random = (): number => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
  const { boxes, lines } = BUDGET[type];
  const steps: number[][] = Array.from({ length: depth }, () => []);
  for (let i = 0; i < boxes; i++) {
    let k = i < depth ? i : Math.floor(random() * depth);
    for (let t = 0; steps[k]!.length >= BREADTH_BUDGET && t < depth; t++) k = (k + 1) % depth;
    steps[k]!.push(i);
  }
  const leaf = type === 'context' ? 'system' : type === 'code' ? 'file' : 'container';
  const elements = Array.from({ length: boxes }, (_, i) => ({ id: `n${i}`, type: leaf, name: type === 'code' ? `src/file${i}.ts` : `Element ${i}`, technology: 'Rust' })) as DiagramSpec['elements'];
  const relationships: DiagramSpec['relationships'] = [];
  const seen = new Set<string>();
  const add = (a: number, b: number): void => {
    if (a === b || seen.has(`${a} ${b}`)) return;
    seen.add(`${a} ${b}`);
    relationships.push({ from: `n${a}`, to: `n${b}`, label: type === 'code' ? '' : 'Sends data to', ...(type === 'dynamic' ? { order: relationships.length + 1 } : {}) });
  };
  for (let k = 1; k < depth; k++) for (const b of steps[k]!) add(steps[k - 1]![Math.floor(random() * steps[k - 1]!.length)]!, b);
  for (let guard = 0; relationships.length < lines && guard < 500; guard++) {
    const k = Math.floor(random() * (depth - 1));
    add(steps[k]![Math.floor(random() * steps[k]!.length)]!, steps[k + 1]![Math.floor(random() * steps[k + 1]!.length)]!);
  }
  return { title: 'At the budget', type, elements, relationships };
}

test('budget: a spec at the limit of its type has a layout that passes every gate', async () => {
  const { judge } = await import('../src/diagram/fit.ts');
  const { over } = await import('../src/diagram/budget.ts');
  for (const type of ['context', 'container', 'component', 'code', 'dynamic', 'deployment', 'landscape'] as const) {
    const depths = type === 'code' ? [3] : [3, 5, 8].filter((d) => d <= BUDGET[type].boxes && Math.ceil(BUDGET[type].boxes / d) <= BREADTH_BUDGET);
    for (const depth of depths) for (const seed of [1, 2, 3, 4, 5]) {
      const spec = atBudget(type, depth, seed);
      assert.deepEqual(over(spec), [], `${type} depth ${depth} seed ${seed} is inside the budget`);
      const { report } = await judge(spec);
      assert.ok(report.passed, `${type} depth ${depth} seed ${seed}: ${report.why}`);
    }
  }
});
