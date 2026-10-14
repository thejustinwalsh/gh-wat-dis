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
import { GOLDEN } from '../src/diagram/judge.ts';
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
    assert.deepEqual(kept.fails.filter((g) => g !== 'width' && g !== 'height'), [], `${name}: ${out.report.why}`);
    assert.equal(kept.fails.includes('width'), out.width > MAX_WIDTH, name);
    assert.equal(kept.fails.includes('height'), out.height > Math.round(MAX_WIDTH * GOLDEN), name);
    assert.equal(out.report.passed, kept.fails.length === 0, name);
    table[name] = `${out.report.passed ? `rung ${out.report.rung} of ${out.report.rungs}` : `no rung of ${out.report.rungs}: ${kept.fails.join(', ')}`} | ${out.width} x ${out.height} | ${out.direction === 'RIGHT' ? 'left to right' : 'top down'}${out.numbered ? ', numbered' : ''}${kept.wrapped ? ', wrapped' : ''}`;
  }
  if (process.env.UPDATE_LAYOUT) writeFileSync(EXPECTED, JSON.stringify(table, null, 2) + '\n');
  assert.deepEqual(table, JSON.parse(readFileSync(EXPECTED, 'utf8')), 'a drawing moved: look at it, then run UPDATE_LAYOUT=1 node --test test/layout.test.ts');
});
