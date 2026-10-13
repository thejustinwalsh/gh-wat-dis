import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lintSpec, renderSvg, toMermaid } from '../src/diagram/index.ts';
import { fit, textWidth, wrap } from '../src/diagram/measure.ts';
import { DARK, FILLS, LIGHT, STATUS_COLOURS, contrast } from '../src/diagram/theme.ts';
import { fit as fitLayout } from '../src/diagram/fit.ts';
import { GROUP_PAD_X, crossesRect, groupLabelWidth, layout } from '../src/diagram/layout.ts';
import type { Layout, NodeBox, Rect } from '../src/diagram/layout.ts';
import type { DiagramSpec } from '../src/spec.ts';

const example = (name: string): DiagramSpec =>
  JSON.parse(readFileSync(new URL(`../examples/diagrams/${name}.json`, import.meta.url), 'utf8')) as DiagramSpec;

const base = (): DiagramSpec => ({
  title: 'Orders',
  type: 'container',
  elements: [
    { id: 'web', type: 'container', name: 'Web', technology: 'TypeScript', description: 'Storefront' },
    { id: 'api', type: 'container', name: 'API', technology: 'Rust', description: 'Order API' },
  ],
  relationships: [{ from: 'web', to: 'api', label: 'Places orders', technology: 'HTTPS' }],
});
const lint = (edit: (s: any) => void): { errors: string; warnings: string } => {
  const spec = base();
  edit(spec);
  const r = lintSpec(spec);
  return { errors: r.errors.join('\n'), warnings: r.warnings.join('\n') };
};

test('a clean spec and every shipped example lint without errors', () => {
  assert.deepEqual(lintSpec(base()), { errors: [], warnings: [] });
  for (const name of ['context', 'container', 'change-impact', 'dynamic', 'whole-system', 'focused', 'code']) {
    assert.deepEqual(lintSpec(example(name)).errors, [], name);
  }
  assert.deepEqual(lintSpec(example('container')).warnings, []);
});

test('lint: structure errors', () => {
  assert.match(lintSpec(null).errors[0]!, /JSON object/);
  assert.match(lint((s) => { delete s.title; }).errors, /title is missing/);
  assert.match(lint((s) => { s.type = 'flow'; }).errors, /type must be one of/);
  assert.match(lint((s) => { s.elements[1].id = 'web'; }).errors, /"web" is used more than once/);
  assert.match(lint((s) => { s.elements[0].parent = 'nope'; }).errors, /parent "nope", which does not exist/);
  assert.match(lint((s) => { s.relationships[0].to = 'nope'; }).errors, /to "nope" does not exist/);
  assert.match(lint((s) => { s.elements[0].parent = 'api'; s.elements[1].parent = 'web'; }).errors, /parent cycle/);
  assert.match(lint((s) => { s.elements[0].name = ' '; }).errors, /"web" has no name/);
  assert.match(lint((s) => { s.elements[0].type = 'service'; }).errors, /unknown type "service"/);
  assert.match(lint((s) => { s.elements[0].status = 'new'; }).errors, /unknown status "new"/);
  assert.match(lint((s) => { s.relationships[0].status = 'new'; }).errors, /unknown status "new"/);
});

test('lint: relationship labels must say something', () => {
  assert.match(lint((s) => { s.relationships[0].label = ''; }).errors, /has no label/);
  for (const vague of ['uses', 'Calls', 'depends on']) {
    assert.match(lint((s) => { s.relationships[0].label = vague; }).errors, /says nothing/);
  }
  assert.equal(lint((s) => { s.relationships[0].label = 'Uses the price cache'; }).errors, '');
});

test('lint: review checklist warnings do not fail', () => {
  const noTech = lint((s) => { delete s.elements[0].technology; });
  assert.equal(noTech.errors, '');
  assert.match(noTech.warnings, /container "web" has no technology/);
  assert.match(lint((s) => { delete s.elements[0].description; }).warnings, /"web" has no description/);
  assert.equal(lint((s) => { s.elements.push({ id: 'b', type: 'boundary', name: 'Zone' }); }).warnings, '');
  assert.match(lint((s) => { delete s.relationships[0].technology; }).warnings, /name the protocol/);
  assert.match(lint((s) => { s.elements[0].description = 'x'.repeat(121); }).warnings, /121 characters/);
  assert.match(lint((s) => { s.type = 'context'; }).warnings, /context diagrams show people and systems; "web" is a container/);
});

test('lint: size limits', () => {
  const many = (count: number) => lint((s) => {
    for (let i = 0; i < count - 2; i++) s.elements.push({ id: `c${i}`, type: 'component', name: `C${i}`, technology: 'Rust', description: 'd' });
  });
  assert.equal(many(15).warnings, '');
  assert.match(many(16).warnings, /16 elements is more than 15; split the diagram or focus it with `graph focus`/);
  assert.equal(many(40).errors, '');
  assert.match(many(41).errors, /41 elements is more than 40/);
});

test('measure: wrap is greedy and breaks long words', () => {
  assert.deepEqual(wrap('one two', 12, 500), ['one two']);
  const lines = wrap(`see ${'x'.repeat(80)} end`, 12, 180);
  assert.ok(lines.length > 2);
  for (const line of lines) assert.ok(textWidth(line, 12) <= 180, line);
  assert.equal(lines.join('').replace(/ /g, ''), `see${'x'.repeat(80)}end`);
  assert.ok(textWidth('Order', 14, true) > textWidth('Order', 14));
  assert.match(fit('A very long group name indeed', 13, 80, true), /…$/);
});

const TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>/g;
function assertWellFormed(svg: string): void {
  const stack: string[] = [];
  let last = 0;
  for (const m of svg.matchAll(TAG)) {
    const between = svg.slice(last, m.index);
    assert.doesNotMatch(between, /[<>]|&(?!(amp|lt|gt|quot|#39);)/, `raw markup in text: ${between.slice(0, 60)}`);
    last = m.index + m[0].length;
    if (m[1]) assert.equal(stack.pop(), m[2], `closing </${m[2]}>`);
    else if (!m[4]) stack.push(m[2]!);
  }
  assert.deepEqual(stack, []);
  assert.equal(svg.slice(last).trim(), '');
}

test('svg: well formed, self contained and accessible', async () => {
  const spec = example('change-impact');
  spec.title = 'Fraud <script>alert("x")</script> & \'more\'';
  spec.elements[1]!.description = 'a < b && c > d';
  for (const theme of ['auto', 'light', 'dark'] as const) {
    const svg = await renderSvg(spec, { theme });
    assertWellFormed(svg);
    assert.doesNotMatch(svg, /<script|foreignObject|<image|href=|url\(|@import|@font-face/);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+" width="\d+" height="\d+" role="img"/);
    assert.match(svg, /<title id="dg-title">.+<\/title><desc id="dg-desc">Container diagram for .+\d+ elements: .+\d+ relationships: .+<\/desc>/);
    assert.match(svg, /<rect class="bg"/);
  }
});

test('svg: same spec gives the same bytes', async () => {
  for (const name of ['container', 'whole-system']) {
    const a = await renderSvg(example(name));
    assert.equal(await renderSvg(example(name)), a);
    assert.equal(await renderSvg(JSON.parse(JSON.stringify(example(name))) as DiagramSpec), a);
  }
});

test('svg: themes', async () => {
  const auto = await renderSvg(example('container'));
  assert.match(auto, /@media \(prefers-color-scheme:dark\)/);
  assert.match(auto, /var\(--fg\)/);
  const light = await renderSvg(example('container'), { theme: 'light' });
  const dark = await renderSvg(example('container'), { theme: 'dark' });
  for (const svg of [light, dark]) assert.doesNotMatch(svg, /var\(|prefers-color-scheme/);
  assert.ok(light.includes(LIGHT.bg) && dark.includes(DARK.bg));
  assert.notEqual(light, dark);
});

test('svg: status is text and line style, and the key lists only what is used', async () => {
  const impact = await renderSvg(example('change-impact'));
  for (const badge of ['+ ADDED', '~ CHANGED', '− REMOVED', 'AFFECTED']) assert.ok(impact.includes(`>${badge}<`), badge);
  for (const cls of ['s-added', 's-changed', 's-removed', 's-affected', 'e-added', 'e-changed', 'e-removed', 'e-affected', 'strike', 'ring']) {
    assert.ok(impact.includes(`class="${cls}`) || impact.includes(` ${cls}"`), cls);
  }
  const key = (svg: string): string => svg.slice(svg.indexOf('>KEY<'));
  assert.match(key(impact), />\+ Added<.*>~ Changed<.*>− Removed<.*>Affected</);
  assert.doesNotMatch(key(impact), />Person</);
  const plain = key(await renderSvg(example('container')));
  assert.match(plain, />Person<.*>Container<.*>Data Store<.*>Queue<.*>External<.*>Group<.*>Relationship/);
  assert.doesNotMatch(plain, /Added|Changed|Removed|Affected|Component/);
  assert.match(await renderSvg(example('dynamic'), { labels: 'text' }), />1\. Submits the checkout.*>Numbered step</s);
});

test('svg: a 12 element container diagram stays near 900px wide', async () => {
  const width = Number(/width="(\d+)"/.exec(await renderSvg(example('container')))![1]);
  assert.ok(width >= 600 && width <= 1000, String(width));
});

test('svg: broken references are skipped when lint is off', async () => {
  const spec = base();
  spec.elements[0]!.parent = 'missing';
  spec.relationships.push({ from: 'api', to: 'missing', label: 'Dangles' });
  assertWellFormed(await renderSvg(spec));
});

test('palette: text meets WCAG AA in both themes', () => {
  for (const [name, p] of [['light', LIGHT], ['dark', DARK]] as const) {
    for (const fill of FILLS) {
      for (const ink of ['fg', 'muted'] as const) {
        assert.ok(contrast(p[ink], p[fill]) >= 4.5, `${name}: ${ink} on ${fill} is ${contrast(p[ink], p[fill]).toFixed(2)}`);
      }
    }
    for (const status of STATUS_COLOURS) {
      assert.ok(contrast(p.onStatus, p[status]) >= 4.5, `${name}: badge text on ${status}`);
      assert.ok(contrast(p[status], p.bg) >= 4.5, `${name}: ${status} mark on bg`);
      assert.ok(contrast(p[status], p.group) >= 3, `${name}: ${status} border on group`);
    }
    assert.ok(contrast(p.line, p.bg) >= 3 && contrast(p.stroke, p.bg) >= 3, `${name}: lines`);
  }
  assert.equal(Math.round(contrast('#000000', '#ffffff')), 21);
});

test('mermaid: flowchart with subgraphs, shapes and statuses', () => {
  const text = toMermaid(example('change-impact'));
  assert.match(text, /^flowchart TB\n/);
  assert.match(text, /subgraph checkout\["Checkout platform \[Software System\]"\]/);
  assert.match(text, /orders_db\[\("Orders database<br\/>\[Data Store: PostgreSQL 16\]/);
  assert.match(text, /events\[\["Order events/);
  assert.match(text, /payments ==>\|"\+ ADDED: Asks for a risk score \[gRPC\]"\| fraud/);
  assert.match(text, /fraud_cron -\.->\|/);
  assert.match(text, /classDef removed stroke:#cf222e/);
  assert.match(text, /class fraud added/);
  assert.equal(text.match(/^\s*subgraph /gm)!.length, text.match(/^\s*end$/gm)!.length);
  const odd = toMermaid({ ...base(), direction: 'RIGHT', elements: [{ id: 'end', type: 'person', name: 'Say "hi"' }], relationships: [] });
  assert.match(odd, /^flowchart LR\n {2}n_end\(\["Say #quot;hi#quot;<br\/>\[Person\]"\]\)/);
});

test('fit: a flow draws left to right with numbered steps inside the page width', async () => {
  const { render, toLegend, MAX_WIDTH } = await import('../src/diagram/index.ts');
  const flow = await render(example('dynamic'));
  assert.equal(flow.direction, 'RIGHT');
  assert.equal(flow.numbered, true);
  assert.ok(flow.width <= MAX_WIDTH, `${flow.width}`);
  assert.match(flow.svg, /class="en"[^>]*>1</);
  const legend = toLegend(example('dynamic'));
  assert.match(legend, /^\| # \| From \| To \| What \| How \|/);
  assert.match(legend, /\| 1 \| Shopper \| Storefront \| Submits the checkout form \| `HTTPS` \|/);
  const forced = await render(example('dynamic'), { labels: 'text', direction: 'DOWN' });
  assert.equal(forced.numbered, false);
  assert.equal(forced.direction, 'DOWN');
});

const stress = (): DiagramSpec =>
  JSON.parse(readFileSync(new URL('./fixtures/diagram-stress.json', import.meta.url), 'utf8')) as DiagramSpec;
const box = (l: Layout, id: string): NodeBox => l.nodes.find((b) => b.el.id === id)!;
const overlap = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (inner: Rect, outer: Rect): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
/** Every way `fit` may lay a spec out. */
async function layouts(spec: DiagramSpec): Promise<Layout[]> {
  const all: Layout[] = [];
  for (const direction of ['DOWN', 'RIGHT'] as const) {
    for (const numbered of [false, true]) all.push(await layout(spec, { direction, numbered }));
  }
  return all;
}

test('layout: a group is as wide as its label, so the label is never cut', async () => {
  const name = 'Payments and settlement reconciliation platform for the European region';
  const spec: DiagramSpec = {
    title: 'Long group', type: 'container',
    elements: [
      { id: 'g', type: 'system', name, kind: 'Bounded context, team Ledger' },
      { id: 'in', type: 'node', name: 'Primary database cluster node group in Frankfurt', parent: 'g', status: 'changed' },
      { id: 'c', type: 'container', name: 'Job', technology: 'Rust', parent: 'in' },
      { id: 'empty', type: 'boundary', name: 'An empty zone with a rather long name as well', status: 'added' },
    ],
    relationships: [{ from: 'c', to: 'empty', label: 'Writes the audit trail' }],
  };
  for (const l of await layouts(spec)) {
    for (const id of ['g', 'in', 'empty']) {
      const b = box(l, id);
      const room = b.w - 2 * GROUP_PAD_X - (b.badge ? b.badge.w : 0);
      assert.ok(room >= groupLabelWidth(b.el), `${l.direction} ${id}: ${b.w}px for a ${Math.ceil(groupLabelWidth(b.el))}px label`);
      if (b.badge) {
        assert.ok(inside(b.badge, b), `${id} badge is inside the group`);
        assert.ok(b.badge.x >= b.x + GROUP_PAD_X + groupLabelWidth(b.el), `${id} badge is clear of the label`);
      }
    }
    assert.ok(inside(box(l, 'in'), box(l, 'g')), 'the widened group still fits inside its parent');
  }
  for (const direction of ['DOWN', 'RIGHT'] as const) {
    const svg = await renderSvg(spec, { direction });
    assertWellFormed(svg);
    assert.doesNotMatch(svg, /\u2026/);
    assert.ok(svg.includes(`>${name}<tspan class="gk" dx="8">[Bounded context, team Ledger]</tspan>`), 'name and kind on one line');
    assert.ok(svg.includes('>Primary database cluster node group in Frankfurt<'));
    assert.ok(svg.includes('>An empty zone with a rather long name as well<'));
  }
  // A group whose label already fits is left alone.
  const plain = await fitLayout(example('change-impact'));
  const checkout = box(plain, 'checkout');
  assert.ok(checkout.w - 2 * GROUP_PAD_X > groupLabelWidth(checkout.el) + 100);
});

test('layout: no relationship line runs under a status badge', async () => {
  const hub: DiagramSpec = {
    title: 'Hub', type: 'container', detail: 'compact',
    elements: [
      ...['a', 'b', 'c', 'd'].map((id) => ({ id, type: 'container' as const, name: `Source ${id}`, technology: 'Rust', status: 'changed' as const })),
      { id: 'hub', type: 'container', name: 'A hub with a long name that wraps', technology: 'Rust', status: 'added' },
      { id: 'store', type: 'datastore', name: 'Store', technology: 'PostgreSQL', status: 'removed' },
      { id: 'bus', type: 'queue', name: 'Bus', technology: 'NATS', status: 'affected' },
    ],
    relationships: [
      ...['a', 'b', 'c', 'd'].map((id) => ({ from: id, to: 'hub', label: `Sends ${id}` })),
      { from: 'hub', to: 'store', label: 'Writes rows' },
      { from: 'hub', to: 'bus', label: 'Publishes events' },
      { from: 'bus', to: 'a', label: 'Feeds back' },
    ],
  };
  let underOldBadge = 0, checked = 0;
  const specs = [hub, stress(), ...['change-impact', 'in-process', 'focused', 'whole-system'].map(example)];
  for (const spec of specs) {
    for (const l of [...await layouts(spec), await fitLayout(spec)]) {
      const marked = l.nodes.filter((b) => b.el.status && b.el.status !== 'unchanged');
      for (const b of marked) {
        assert.ok(b.badge, `${b.el.id} has a badge`);
        assert.ok(inside(b.badge, b), `${spec.title}: ${b.el.id} badge is inside its element`);
        for (const e of l.edges) {
          checked++;
          assert.ok(!crossesRect(e.points, b.badge, 2),
            `${spec.title} (${l.direction}${l.numbered ? ', numbered' : ''}): ${e.rel.from} -> ${e.rel.to} runs under the badge of ${b.el.id}`);
        }
        // Where the badge used to be: across the top border, at the right.
        if (!b.group) {
          const old = { x: b.x + b.w - 10 - b.badge.w, y: b.y - 9, w: b.badge.w, h: 18 };
          underOldBadge += l.edges.filter((e) => (e.rel.from === b.el.id || e.rel.to === b.el.id) && crossesRect(e.points, old)).length;
        }
      }
      for (const b of l.nodes.filter((n) => !n.badge)) assert.ok(!b.el.status || b.el.status === 'unchanged');
      // A leaf badge never covers the element's own text.
      for (const b of marked.filter((n) => !n.group)) {
        for (const line of b.lines) {
          const w = textWidth(line.text, 14, true);
          const text = { x: b.x + b.w / 2 - w / 2, y: b.y + line.dy - 10.5, w, h: 12 };
          assert.ok(!overlap(text, b.badge!), `${spec.title}: ${b.el.id} badge covers "${line.text}"`);
        }
      }
    }
  }
  assert.ok(checked > 500);
  assert.ok(underOldBadge > 0, 'the specs include lines that enter a marked element at its top right');
  const svg = await renderSvg(hub);
  for (const words of ['+ ADDED', '~ CHANGED', '\u2212 REMOVED', 'AFFECTED']) assert.ok(svg.includes(`>${words}<`), words);
});

test('layout: a self-relationship draws a loop large enough to read, with its label beside it', async () => {
  const spec = stress();
  const loops = spec.relationships.filter((r) => r.from === r.to);
  assert.equal(loops.length, 2);
  for (const l of await layouts(spec)) {
    for (const e of l.edges.filter((p) => p.rel.from === p.rel.to)) {
      const where = `${l.direction}${l.numbered ? ', numbered' : ''}: ${e.rel.from}`;
      const xs = e.points.map((p) => p.x), ys = e.points.map((p) => p.y);
      const bounds = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      assert.ok(bounds.w >= 24 && bounds.h >= 24, `${where} loop is ${bounds.w} x ${bounds.h}`);
      const node = box(l, e.rel.from);
      assert.ok(e.label, `${where} has a label`);
      assert.ok(!overlap(e.label, node), `${where} label overlaps its element`);
      assert.ok(!crossesRect(e.points, e.label), `${where} loop runs through its label`);
      // The loop leaves the element: its far side is outside the box.
      assert.ok(!inside(bounds, node), where);
      for (const other of l.edges) {
        if (other !== e && other.label) assert.ok(!overlap(e.label, other.label), `${where} label overlaps the label of ${other.rel.from} -> ${other.rel.to}`);
      }
    }
  }
  const text = await renderSvg(spec, { labels: 'text' });
  assertWellFormed(text);
  assert.ok(text.includes('Retries with backoff') && text.includes('>Compacts the topic<'));
  assert.equal(await renderSvg(stress(), { labels: 'text' }), text);
  assert.match(await renderSvg(spec, { labels: 'numbered' }), /class="en"[^>]*>6</);
});

test('png: a drawing comes out as a PNG at twice the size, with fixed colours', async () => {
  const { toPng } = await import('../src/tools/raster.ts');
  const { renderSvg } = await import('../src/diagram/svg.ts');
  const spec = { title: 'T', type: 'container', elements: [
    { id: 'a', type: 'container', name: 'A', technology: 'X' }, { id: 'b', type: 'container', name: 'B', technology: 'Y' },
  ], relationships: [{ from: 'a', to: 'b', label: 'Sends to', technology: 'HTTPS' }] } as never;
  const svg = await renderSvg(spec, { theme: 'light' });
  assert.doesNotMatch(svg, /var\(--/);
  const size = /viewBox="0 0 (\d+) (\d+)"/.exec(svg)!;
  const image = toPng(svg);
  assert.deepEqual([...image.png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.deepEqual([image.width, image.height], [Number(size[1]) * 2, Number(size[2]) * 2]);
});

test('png: the check tells a drawing with its text from one without, and a blank one', async () => {
  const { toPng, drawsText } = await import('../src/tools/raster.ts');
  const { renderSvg } = await import('../src/diagram/svg.ts');
  const { checkPng, decodePng } = await import('../scripts/check-png.ts');
  const spec = JSON.parse(readFileSync(new URL('../examples/diagrams/dynamic.json', import.meta.url), 'utf8')) as never;
  const svg = await renderSvg(spec, { theme: 'light' });
  const image = toPng(svg);
  const decoded = decodePng(image.png);
  assert.deepEqual([decoded.width, decoded.height, decoded.rgba.length], [image.width, image.height, image.width * image.height * 4]);

  // A machine with no usable font draws no text and reports no error. This fails there, by design.
  assert.ok(drawsText(), 'the rasterizer found no font on this machine, so PNG previews hold no text');
  const good = checkPng('dynamic', svg, image.png);
  assert.deepEqual(good.problems, []);
  assert.ok(good.textPixels > good.characters * 20, `${good.textPixels} pixels for ${good.characters} characters`);

  // The same drawing as a machine with no font would produce it.
  const noText = toPng(svg.replace(/<text\b[^>]*>[\s\S]*?<\/text>/g, ''));
  assert.match(checkPng('dynamic', svg, noText.png).problems.join('\n'), /no text was drawn: 0 pixels differ/);

  const size = /viewBox="0 0 (\d+) (\d+)"/.exec(svg)!;
  const blank = toPng(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size[1]} ${size[2]}" width="${size[1]}" height="${size[2]}"/>`);
  assert.match(checkPng('dynamic', svg, blank.png).problems.join('\n'), /the PNG is blank: it holds 1 colour/);
  assert.match(checkPng('dynamic', svg.replace(/viewBox="0 0 \d+/, 'viewBox="0 0 10'), image.png).problems.join('\n'), /twice the SVG viewBox/);
  assert.match(checkPng('dynamic', svg, new TextEncoder().encode('<svg/>')).problems.join('\n'), /not a PNG/);
});

const fixture = (name: string): DiagramSpec =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as DiagramSpec;

test('judge: every example keeps short lines, few corners, clear boxes and clear labels', async () => {
  const { judge } = await import('../src/diagram/fit.ts');
  const specs: [string, DiagramSpec][] = [
    ...['context', 'container', 'change-impact', 'dynamic', 'focused', 'in-process', 'code', 'whole-system'].map((n): [string, DiagramSpec] => [n, example(n)]),
    ['three groups', fixture('diagram-three-groups')], ['five components', fixture('diagram-five-components')], ['containers', fixture('diagram-containers')],
  ];
  for (const [name, spec] of specs) {
    const { report } = await judge(spec);
    const c = report.candidates.find((k) => k.chosen)!;
    assert.ok(c.longest <= 1.2, `${name}: a line is ${c.longest} times the diagonal`);
    assert.ok(c.maxBends <= (name === 'in-process' ? 8 : 4), `${name}: a line has ${c.maxBends} corners`);
    assert.ok(c.bends <= c.lines * 3, `${name}: ${c.bends} corners on ${c.lines} lines`);
    assert.ok(c.detour <= c.lines * 160, `${name}: ${c.detour}px of detour on ${c.lines} lines`);
    assert.ok(c.crossings <= Math.max(1, c.lines / 4), `${name}: ${c.crossings} crossings on ${c.lines} lines`);
    assert.equal(c.through, 0, `${name}: a line runs through a box`);
    assert.equal(c.overlaps, 0, `${name}: a label lies on a line or a box`);
    assert.equal(c.broken, 0, `${name}: a relationship is not drawn`);
    // The examples are the good cases: none draws a warning about its lines. A few are too wide or too tall, and say so.
    // `in-process` nests three groups deep, and lines enter two of them through the name.
    const allowed = (w: string): boolean => w.includes('is wider than') || w.includes('px tall') || w.includes('name of a group');
    assert.deepEqual(report.warnings.filter((w) => !allowed(w)), [], name);
  }
});

test('judge: a small change never gets wrap-around lines to save height or width', async () => {
  const { render } = await import('../src/diagram/svg.ts');
  for (const name of ['diagram-three-groups', 'diagram-five-components']) {
    const out = await render(fixture(name));
    const c = out.report.candidates.find((k) => k.chosen)!;
    assert.ok(out.width <= 860, `${name}: ${out.width}px wide`);
    assert.ok(c.detour <= 60, `${name}: ${c.detour}px of detour`);
    assert.ok(c.maxBends <= 4 && c.longest < 0.6, `${name}: ${c.maxBends} corners, ${c.longest} of the diagonal`);
    assert.ok(out.report.why.startsWith('kept top down, words on the lines'), out.report.why);
  }
  // The spec asks for left to right, which is far too wide here. The report says why it was turned.
  const turned = await render(fixture('diagram-three-groups'));
  assert.match(turned.report.why, /left to right is \d+px (wide|taller)/);
  // The container view of this repository, both ways: no line leaves by the far edge to come back in.
  for (const direction of [undefined, 'RIGHT', 'DOWN'] as const) {
    const out = await render(fixture('diagram-containers'), direction ? { direction } : {});
    const c = out.report.candidates.find((k) => k.chosen)!;
    assert.ok(c.worst === undefined && c.longest <= 0.9 && c.maxBends <= 6, `containers ${direction ?? 'auto'}: ${JSON.stringify(c.worst)} ${c.longest} ${c.maxBends}`);
  }
  // On the command line a direction is an order.
  const forced = await render(fixture('diagram-three-groups'), { direction: 'RIGHT' });
  assert.equal(forced.direction, 'RIGHT');
  assert.ok(forced.report.candidates.every((k) => k.direction === 'RIGHT'));
});

test('judge: a detour, a crossing and a covered label each cost more than the height they save', async () => {
  const { lineCost, faults } = await import('../src/diagram/judge.ts');
  const calm = { lines: 4, length: 800, detour: 0, longest: 0.3, bends: 4, maxBends: 2, crossings: 0, through: 0, overlaps: 0, titles: 0 };
  assert.equal(lineCost(calm), 0);
  assert.ok(lineCost({ ...calm, detour: 2000 }) > 1000);
  assert.ok(lineCost({ ...calm, through: 1 }) >= 300 && lineCost({ ...calm, overlaps: 1 }) >= 200);
  assert.deepEqual(faults(calm, (id) => id), []);
  assert.ok(lineCost({ ...calm, titles: 1 }) >= 100);
  const poor = faults({ ...calm, crossings: 3, through: 1, overlaps: 2, titles: 1, worst: { from: 'a', to: 'b', length: 1900, direct: 300 } }, (id) => id.toUpperCase());
  assert.deepEqual(poor, [
    'the line from "A" to "B" runs 1900px where 300px would join them',
    '1 line passes through a box that is not theirs',
    '3 line crossings on 4 lines',
    '2 places where a label lies on a line or a box, or one line lies on another',
    '1 line runs through the name of a group',
  ]);
  // A fault states what is wrong. A fix is printed by the tool only after it was tried.
  assert.doesNotMatch(poor.join(' '), /graph |--labels/);
  assert.deepEqual(faults({ ...calm, crossings: 2 }, (id) => id), []);
});

test('legend: the table rows carry the numbers drawn on the lines, in the same order', async () => {
  const { render, toLegend } = await import('../src/diagram/index.ts');
  const drawn = (svg: string): number[] => [...svg.matchAll(/<text class="en"[^>]*>(\d+)<\/text>/g)].map((m) => Number(m[1]));
  const rows = (spec: DiagramSpec): string[][] => toLegend(spec).trim().split('\n').slice(2).map((line) => line.split(' | ').map((c) => c.replace(/^\| | \|$/g, '')));
  // A structure diagram: lines are numbered in the order the spec lists them, and row n is relationship n.
  const structure = fixture('diagram-containers');
  const out = await render(structure, { labels: 'numbered' });
  assert.equal(out.numbered, true);
  const count = structure.relationships.length;
  assert.deepEqual(drawn(out.svg), Array.from({ length: count }, (_, i) => i + 1));
  const name = new Map(structure.elements.map((e) => [e.id, e.name]));
  assert.deepEqual(rows(structure).map((r) => [Number(r[0]), r[1], r[2], r[3]]),
    structure.relationships.map((r, i) => [i + 1, name.get(r.from), name.get(r.to), r.label]));
  // A flow: each line carries its `order`, and the table is sorted by it even when the spec is not.
  const flow = example('dynamic');
  flow.relationships.reverse();
  const steps = await render(flow);
  assert.equal(steps.numbered, true);
  assert.deepEqual(drawn(steps.svg), flow.relationships.map((r) => r.order));
  assert.deepEqual(rows(flow).map((r) => Number(r[0])), [1, 2, 3, 4, 5, 6, 7]);
  const names = new Map(flow.elements.map((e) => [e.id, e.name]));
  for (const r of flow.relationships) assert.deepEqual(rows(flow)[r.order! - 1]!.slice(1, 4), [names.get(r.from), names.get(r.to), r.label]);
});

test('code: a file is a card with a row per symbol, and a line ends on the row it names', async () => {
  const spec = example('code');
  assert.deepEqual(lintSpec(spec), { errors: [], warnings: [] });
  const l = await layout(spec, { direction: 'RIGHT', flat: true });
  for (const b of l.nodes) {
    if (b.el.type !== 'file') continue;
    assert.ok(b.card && b.badge === undefined, b.el.id);
    assert.deepEqual(b.card.rows.map((r) => r.name), (b.el.symbols ?? []).map((s) => s.name));
    // Rows lie inside the card, one under the other, below the header.
    b.card.rows.forEach((r, i) => assert.ok(r.dy > b.card!.head && r.dy < b.h && (i === 0 || r.dy > b.card!.rows[i - 1]!.dy), `${b.el.id} row ${r.name}`));
  }
  for (const e of l.edges) {
    const to = box(l, e.rel.to), from = box(l, e.rel.from), tip = e.points.at(-1)!, tail = e.points[0]!;
    const row = to.card!.rows.find((r) => r.name === e.rel.toSymbol);
    // The line ends on the left edge of the card, level with its row, or with the header when it names no symbol.
    assert.ok(Math.abs(tip.x - to.x) < 0.5, `${e.rel.from} -> ${e.rel.to} ends on the left edge`);
    // Lines that share a row sit a few pixels apart, inside the row.
    assert.ok(Math.abs(tip.y - (to.y + (row ? row.dy : to.card!.head / 2))) <= 7, `${e.rel.from} -> ${e.rel.to}#${e.rel.toSymbol ?? ''}`);
    assert.ok(Math.abs(tail.x - (from.x + from.w)) < 0.5 && Math.abs(tail.y - (from.y + from.card!.head / 2)) <= 7);
    // No two lines share an end: each can be followed from its file to its row.
    for (const o of l.edges) if (o !== e) assert.ok(Math.hypot(o.points.at(-1)!.x - tip.x, o.points.at(-1)!.y - tip.y) > 2, `${e.rel.from} and ${o.rel.from} end on one point of ${e.rel.to}`);
    assert.equal(e.label, undefined);
    for (const b of l.nodes) if (b !== to && b !== from && !b.group) assert.ok(!crossesRect(e.points, b, -1), `${e.rel.from} -> ${e.rel.to} crosses ${b.el.id}`);
  }
  const files = l.nodes.filter((b) => b.card);
  for (const a of files) for (const b of files) if (a !== b) assert.ok(!overlap(a, b), `${a.el.id} overlaps ${b.el.id}`);

  const { render } = await import('../src/diagram/svg.ts');
  const out = await render(spec);
  // Five files fit the page with room to spare, left to right, with no words to number.
  assert.ok(out.width <= 760 && out.height <= 480, `${out.width} x ${out.height}`);
  assert.deepEqual([out.direction, out.numbered], ['RIGHT', false]);
  assertWellFormed(out.svg);
  assert.match(out.svg, /^<svg[^>]*><title[^>]*>Payment retries move to idempotency keys: Code diagram for/);
  // Path, symbol names, kinds, and the same marks the lines use. A removed symbol is struck through.
  for (const text of ['>idempotency.rs<', '>services/payments/src/<', '>retry_authorisation<', '>struct<', 'class="sm m-added"', 'class="sm m-changed"', 'class="sm m-removed"', 'class="sm m-affected"']) {
    assert.ok(out.svg.includes(text), text);
  }
  assert.match(out.svg, /<g class="gone"><text class="sy"[^>]*>backoff_schedule<\/text>.*?class="strike"/);
  const key = out.svg.slice(out.svg.indexOf('>KEY<'));
  assert.match(key, />File<.*>Part of the system<.*>Imports<.*>Added<.*>Changed<.*>Removed<.*>Imports a changed signature</);
  assert.doesNotMatch(key, /Boundary|Relationship|ADDED/);
  for (const theme of ['light', 'dark'] as const) assert.doesNotMatch(await renderSvg(spec, { theme }), /var\(--/);

  // Top down there are no rows to end on, so the judge turns to it only when it must.
  const down = await render(spec, { direction: 'DOWN' });
  assert.equal(down.direction, 'DOWN');
  assertWellFormed(down.svg);
});

test('code: lint checks symbols and symbol ends; Mermaid and the legend say what an unlabelled line means', async () => {
  const spec = example('code');
  const edit = (change: (s: any) => void): string => { const s = structuredClone(spec); change(s); const r = lintSpec(s); return [...r.errors, ...r.warnings].join('\n'); };
  assert.match(edit((s) => { s.relationships[0].toSymbol = 'nope'; }), /toSymbol "nope" is not a symbol of "authorise"/);
  assert.match(edit((s) => { s.relationships[0].fromSymbol = 'x'; }), /fromSymbol "x" is not a symbol of "checkout"/);
  assert.match(edit((s) => { s.elements[3].symbols.push({ name: 'authorise' }); }), /lists the symbol "authorise" more than once/);
  assert.match(edit((s) => { s.elements[3].symbols[0].status = 'new'; }), /symbol "authorise" has unknown status "new"/);
  assert.match(edit((s) => { s.elements[3].symbols = 'authorise'; }), /symbols must be an array/);
  assert.match(edit((s) => { s.elements[3].symbols = Array.from({ length: 9 }, (_, i) => ({ name: `f${i}` })); }), /lists 9 symbols and draws the first 8/);
  assert.match(edit((s) => { s.elements[2].type = 'component'; }), /code diagrams show files.*"checkout" is a component/);
  // Only a line between two files may go without words.
  assert.match(edit((s) => { s.elements[2].type = 'component'; }), /checkout -> authorise has no label/);
  const mermaid = toMermaid(spec);
  assert.match(mermaid, /subgraph payments\["Payment service"\]/);
  assert.match(mermaid, /keys\["\+ ADDED<br\/>services\/payments\/src\/idempotency\.rs<br\/>\+ IdempotencyKey<br\/>\+ reserve<br\/>\+ release"\]/);
  assert.match(mermaid, /checkout -->\|"Imports authorise"\| authorise/);
  assert.match(mermaid, /lib -->\|"Imports"\| keys/);
  const { toLegend } = await import('../src/diagram/index.ts');
  assert.match(toLegend(spec), /\| services\/orders\/src\/checkout\.rs \| services\/payments\/src\/authorise\.rs \| Imports authorise \|/);
});

test('cli: stderr says what layout was kept, and --report prints the judgement as JSON', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dir = mkdtempSync(join(tmpdir(), 'wat-report-'));
  const run = (...args: string[]) => spawnSync(process.execPath, [fileURLToPath(new URL('./diagram-run.ts', import.meta.url)), ...args], { encoding: 'utf8' });
  const spec = fileURLToPath(new URL('./fixtures/diagram-three-groups.json', import.meta.url));
  const plain = run(spec, '-o', join(dir, 'a.svg'));
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout.trim(), join(dir, 'a.svg'));
  assert.match(plain.stderr, /^\d+ x \d+px, top down$/m);
  assert.match(plain.stderr, /^layout: kept top down, words on the lines, wrapped onto columns, the best of \d+ layouts: left to right is \d+px/m);
  const out = run(spec, '-o', join(dir, 'b.svg'), '--png', join(dir, 'b.png'), '--report');
  assert.equal(out.status, 0, out.stderr);
  const report = JSON.parse(out.stdout) as { svg: string; png: string; width: number; direction: string; labels: string; why: string; warnings: string[]; candidates: { chosen: boolean; direction: string; score: number; detour: number }[] };
  assert.deepEqual([report.svg, report.png, report.direction, report.labels], [join(dir, 'b.svg'), join(dir, 'b.png'), 'DOWN', 'text']);
  assert.ok(report.width <= 860 && report.why.startsWith('kept top down'));
  assert.deepEqual(report.warnings.filter((w) => !w.includes('name of a group')), []);
  const kept = report.candidates.filter((c) => c.chosen);
  assert.equal(kept.length, 1);
  assert.ok(report.candidates.every((c) => c.score >= kept[0]!.score));
  assert.ok(report.candidates.some((c) => c.direction === 'RIGHT' && c.detour > 0), 'the wrap-around layouts are in the list, with their detours');
  assert.equal(run(spec, '--report', '-o', '-').status, 2);
});

const pressure = (name: string): DiagramSpec =>
  JSON.parse(readFileSync(new URL(`./fixtures/pressure/${name}.json`, import.meta.url), 'utf8')) as DiagramSpec;

test('judge: a layout that drops a line or leaves one hanging is never kept', async () => {
  const { judge } = await import('../src/diagram/fit.ts');
  // ELK returns no route for a line that goes back to an earlier element once it wraps the chain.
  const wrapped = await layout(pressure('08-cycle'), { direction: 'RIGHT', wrap: 2 });
  assert.ok(wrapped.broken > 0, 'the wrapped cycle is the broken layout this test is about');
  const cases: [string, 'RIGHT' | 'DOWN' | undefined][] = [
    ['08-cycle', undefined], ['08-cycle', 'RIGHT'], ['05-long-fix-title', undefined], ['06-dynamic8', 'RIGHT'], ['09-statuses', 'RIGHT'], ['11-code-symrefs-ok', undefined],
  ];
  for (const [name, direction] of cases) {
    const spec = pressure(name);
    const { layout: kept, report } = await judge(spec, direction ? { direction } : {});
    const c = report.candidates.find((k) => k.chosen)!;
    const where = `${name} ${direction ?? 'auto'}`;
    assert.equal(c.broken, 0, where);
    assert.equal(kept.edges.filter((e) => e.points.length > 1).length + kept.folded, spec.relationships.length, `${where}: every relationship is drawn`);
    // Each line starts on its source and ends on its target.
    for (const e of kept.edges) {
      if (e.rel.from === e.rel.to) continue;
      for (const [p, id] of [[e.points[0]!, e.rel.from], [e.points.at(-1)!, e.rel.to]] as const) {
        const b = box(kept, id);
        const near = p.x >= b.x - 12 && p.x <= b.x + b.w + 12 && p.y >= b.y - 18 && p.y <= b.y + b.h + 12;
        assert.ok(near, `${where}: ${e.rel.from} -> ${e.rel.to} has an end at ${Math.round(p.x)},${Math.round(p.y)}, away from ${id}`);
      }
    }
    assert.ok(report.candidates.every((k) => !k.chosen || k.broken === 0));
  }
  // The broken layouts stay in the report, marked, so a reader of the data sees why they lost.
  const cycle = (await judge(pressure('08-cycle'))).report;
  assert.ok(cycle.candidates.some((k) => k.broken > 0 && !k.chosen));
});

test('judge: group names are slid clear of lines, a flow starts on its first step, lines do not lie on one another', async () => {
  const { judge } = await import('../src/diagram/fit.ts');
  const nested = await judge(pressure('04-nested'));
  const c = nested.report.candidates.find((k) => k.chosen)!;
  assert.equal(c.titles, 0, 'no line runs through a group name');
  for (const g of nested.layout.nodes.filter((b) => b.group)) {
    assert.ok(g.title && g.title.x >= g.x && g.title.x + g.title.w <= g.x + g.w + 1, `${g.el.id}: the name is inside its group`);
    for (const e of nested.layout.edges) assert.ok(!crossesRect(e.points, g.title!, 1), `${e.rel.from} -> ${e.rel.to} runs through the name of ${g.el.id}`);
  }
  const flow = await judge(pressure('08-self-dynamic'));
  const first = flow.layout.edges.find((e) => e.rel.order === 1)!;
  assert.ok(first.points[0]!.x < first.points.at(-1)!.x, 'step 1 runs left to right');
  const refs = (await judge(pressure('11-code-symrefs-ok'))).report.candidates.find((k) => k.chosen)!;
  assert.deepEqual([refs.overlaps, refs.worst], [0, undefined]);
});

test('judge: height is warned about, and a fix is printed only after the tool tried it and it helped', async () => {
  const { judge } = await import('../src/diagram/fit.ts');
  const { advise } = await import('../src/diagram/advise.ts');
  const tall = (await judge(pressure('11-code8x6'))).report;
  assert.match(tall.warnings.join('\n'), /the image is \d+px tall/);
  // Forcing a flow left to right makes it too wide. Dropping the option is the fix, and it was judged.
  const forced = { direction: 'RIGHT' as const };
  const wide = (await judge(pressure('06-dynamic8'), forced)).report;
  assert.match(wide.warnings[0]!, /is wider than GitHub's 860px body/);
  const advice = await advise(pressure('06-dynamic8'), forced, wide);
  assert.deepEqual(advice.fixes.map((f) => [f.command, f.warnings]), [['no --direction right', []]]);
  // Nothing mends a spec of eight files that all import one another: no fix is offered.
  const none = await advise(pressure('11-code8x6'), {}, tall);
  assert.deepEqual(none.fixes, []);
  // A warning never names a filter or an option. That is the job of a fix line.
  for (const w of [...tall.warnings, ...wide.warnings]) assert.doesNotMatch(w, /graph |--labels|--direction/);
  // Numbers already on the lines are never offered as the cure.
  const numbered = (await judge(pressure('09-statuses'), { direction: 'RIGHT', labels: 'numbered' })).report;
  assert.doesNotMatch(numbered.warnings.join(' '), /numbered/);
  assert.match((await judge(fixture('diagram-three-groups'))).report.why, /wrapped onto columns/);
});

test('lint: order, empty lists, wrong value types, a file outside a code diagram, a long flow', () => {
  const run = (change: (s: any) => void): string => { const s: any = base(); change(s); const r = lintSpec(s); return [...r.errors.map((e) => `error: ${e}`), ...r.warnings.map((w) => `warning: ${w}`)].join('\n'); };
  assert.match(run((s) => { s.relationships[0].order = -3; }), /error: .*order must be a whole number from 1 to 999, got -3/);
  assert.match(run((s) => { s.relationships[0].order = 1e9; }), /error: .*order must be a whole number/);
  assert.match(run((s) => { s.relationships[0].order = 1; s.relationships.push({ ...s.relationships[0] }); }), /error: .*order 1 is used more than once/);
  assert.match(run((s) => { s.elements = []; s.relationships = []; }), /error: elements is empty: there is nothing to draw/);
  assert.equal(run((s) => { s.title = 7; }), 'error: title must be text');
  assert.match(run((s) => { s.elements[0].name = 7; }), /error: element "web": name must be text/);
  // One structural error is reported alone, not followed by ids that "do not exist".
  assert.equal(run((s) => { s.elements = 'x'; }), 'error: elements must be an array');
  assert.match(run((s) => { s.elements[0].type = 'file'; }), /warning: "web" is a file, which belongs in a code diagram; this is a container diagram/);
  assert.match(run((s) => { s.type = 'dynamic'; s.relationships = Array.from({ length: 9 }, (_, i) => ({ ...s.relationships[0], order: i + 1 })); }), /warning: a flow of 9 steps is more than 8/);
  // Past five elements descriptions are not drawn, so a missing one is not reported.
  const many = (s: any): void => { s.elements = Array.from({ length: 6 }, (_, i) => ({ id: `e${i}`, type: 'container', name: `E${i}`, technology: 'Rust' })); s.relationships = []; };
  assert.equal(run(many), '');
  assert.match(run((s) => { many(s); s.detail = 'full'; }), /warning: element "e0" has no description/);
});

test('legend and png: text from a spec is escaped in the table, and an emoji costs the PNG one box, not the whole line', async () => {
  const { toLegend, renderSvg: draw } = await import('../src/diagram/index.ts');
  const spec = base();
  spec.elements[0]!.name = '<script>alert(1)</script>';
  spec.relationships[0]!.label = 'Sends <b>bold</b> | piped & more';
  const table = toLegend(spec);
  assert.ok(table.includes('| &lt;script&gt;alert(1)&lt;/script&gt; | API | Sends &lt;b&gt;bold&lt;/b&gt; \\| piped &amp; more |'), table);
  assert.doesNotMatch(table, /<script>|<b>/);
  const { toPng } = await import('../src/tools/raster.ts');
  const svg = await draw(pressure('10-unicode'), { theme: 'light' });
  assert.match(svg, /\p{Extended_Pictographic}/u);
  const image = toPng(svg);
  assert.ok(image.emoji > 0);
  assert.equal(toPng(await draw(base(), { theme: 'light' })).emoji, 0);
});

test('round 3: a flow with a group draws, and a layout failure carries the real error', async () => {
  const { judge } = await import('../src/diagram/fit.ts');
  const { render } = await import('../src/diagram/svg.ts');
  const out = await render(pressure('m1-flow-group'));
  assert.equal(out.report.candidates.find((c) => c.chosen)!.broken, 0);
  assertWellFormed(out.svg);
  // `kind` as a number slips past a caller that skips lint. The message says what broke, not only that something did.
  const bad = base();
  (bad.elements[0] as unknown as { kind: number }).kind = 12;
  await assert.rejects(judge(bad), (err: Error) => /^could not lay out the diagram: .+/.test(err.message) && !/no layout was tried/.test(err.message));
});

test('round 3: a container that holds elements is a group in the key, and a boundary is a boundary', async () => {
  const { render } = await import('../src/diagram/svg.ts');
  assert.match((await render(example('container'))).svg, />Group</);
  assert.match((await render(pressure('04-nested'))).svg, />Boundary</);
});

