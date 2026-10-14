import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lintSpec, renderSvg, toMermaid } from '../src/diagram/index.ts';
import { fit, textWidth, wrap } from '../src/diagram/measure.ts';
import { DARK, EBONY_DARK, EBONY_LIGHT, FILLS, LIGHT, PAGES, PALETTES, STATUS_COLOURS, contrast } from '../src/diagram/theme.ts';
import { fit as fitLayout } from '../src/diagram/fit.ts';
import { crossesRect, groupLabelWidth, layout } from '../src/diagram/layout.ts';
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
  assert.equal(many(12).warnings, '');
  // Past the budget of its type, the warning says so. With no change marked and no group to fold, no filter helps.
  assert.match(many(13).warnings, /13 elements is more than the 12 a container diagram holds; no filter brings it inside and keeps the change/);
  // With a change marked, the warning names the filter that brings the spec inside, and what it leaves.
  const marked = lint((s) => {
    for (let i = 0; i < 12; i++) s.elements.push({ id: `c${i}`, type: 'component', name: `C${i}`, technology: 'Rust', description: 'd' });
    s.elements[0].status = 'changed';
  });
  assert.match(marked.warnings, /14 elements is more than the 12 a container diagram holds; `graph focus --on status:changed,added,removed --hops 1` leaves 2 and 1/);
  const lines = lint((s) => { for (let i = 0; i < 14; i++) s.relationships.push({ from: 'web', to: 'api', label: `Sends ${i}`, technology: 'HTTPS' }); });
  assert.match(lines.warnings, /15 relationships is more than the 14 a container diagram holds/);
  assert.match(lint((s) => { s.relationships[0].label = 'x'.repeat(81); }).warnings, /label is 81 characters; keep it under 80/);
  assert.match(lint((s) => { s.elements.push({ id: 'g', type: 'boundary', name: 'g'.repeat(41) }); s.elements[0].parent = 'g'; }).warnings, /group "g" name is 41 characters; keep it under 40/);
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

test('palette: text meets WCAG AA in both themes of each palette', () => {
  const sides = Object.entries(PALETTES).flatMap(([palette, { light, dark }]) => [[`${palette} light`, light], [`${palette} dark`, dark]] as const);
  assert.equal(sides.length, 4);
  for (const [name, p] of sides) {
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

test('palette: a transparent background reads on the GitHub and site pages of its scheme', () => {
  // With no canvas, the title, the key, the lines and the status marks sit on the page itself.
  for (const [palette, sides] of Object.entries(PALETTES)) {
    for (const scheme of ['light', 'dark'] as const) {
      const p = sides[scheme];
      for (const page of PAGES[scheme]) {
        for (const ink of ['fg', 'muted', ...STATUS_COLOURS] as const) {
          assert.ok(contrast(p[ink], page) >= 4.5, `${palette} ${scheme}: ${ink} on page ${page} is ${contrast(p[ink], page).toFixed(2)}`);
        }
        assert.ok(contrast(p.line, page) >= 3 && contrast(p.stroke, page) >= 3, `${palette} ${scheme}: lines on page ${page}`);
      }
    }
  }
});

test('svg: palette and background', async () => {
  const spec = example('change-impact');
  const plain = await renderSvg(spec);
  // The default draws what it drew before the options existed.
  assert.equal(await renderSvg(spec, { palette: 'github', background: 'solid' }), plain);
  assert.ok(plain.includes(`--bg:${LIGHT.bg}`) && plain.includes(`--bg:${DARK.bg}`));
  const ebony = await renderSvg(spec, { palette: 'ebony' });
  assertWellFormed(ebony);
  assert.match(ebony, /@media \(prefers-color-scheme:dark\)/);
  assert.ok(ebony.includes(`--added:${EBONY_LIGHT.added}`) && ebony.includes(`--added:${EBONY_DARK.added}`));
  assert.ok(ebony.includes(`--bg:${EBONY_DARK.bg}`));
  assert.ok(!ebony.includes(DARK.bg));
  // Same layout: only the colours change.
  const shapes = (svg: string): string => svg.replace(/<style>.*<\/style>/s, '');
  assert.equal(shapes(ebony), shapes(plain));
  for (const theme of ['light', 'dark'] as const) {
    const fixed = await renderSvg(spec, { palette: 'ebony', theme });
    assert.doesNotMatch(fixed, /var\(|prefers-color-scheme/);
    assert.ok(fixed.includes((theme === 'light' ? EBONY_LIGHT : EBONY_DARK).changed));
  }
  const clear = await renderSvg(spec, { background: 'transparent' });
  assert.match(clear, /\.bg\{fill:none;stroke:none\}<\/style>/);
  assert.match(clear, /<rect class="bg"/);
  assert.equal(shapes(clear), shapes(plain));
  // Cards keep their fill: only the canvas goes.
  assert.match(await renderSvg(spec, { background: 'transparent', theme: 'dark' }), /\.f-bg\{fill:#0d1117\}.*\.bg\{fill:none;stroke:none\}/);
});

test('cli: --palette and --background', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync: read } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dir = mkdtempSync(join(tmpdir(), 'wat-palette-'));
  const run = (...args: string[]) => spawnSync(process.execPath, [fileURLToPath(new URL('./diagram-run.ts', import.meta.url)), ...args], { encoding: 'utf8' });
  const help = run('--help').stdout;
  assert.match(help, /--palette <name> +github \(default/);
  assert.match(help, /--background <b> +solid \(default\) or transparent/);
  assert.match(help, /Transparent is safe only where the page's colour scheme reaches the SVG/);
  const spec = fileURLToPath(new URL('../examples/diagrams/change-impact.json', import.meta.url));
  const out = run(spec, '-o', join(dir, 'a.svg'), '--palette', 'ebony', '--background', 'transparent', '--png', join(dir, 'a.png'));
  assert.equal(out.status, 0, out.stderr);
  const svg = read(join(dir, 'a.svg'), 'utf8');
  assert.ok(svg.includes(EBONY_DARK.bg) && svg.includes('.bg{fill:none;stroke:none}'));
  const { decodePng } = await import('../scripts/check-png.ts');
  // The PNG keeps a solid canvas in the light side of the palette, so it reads in any viewer.
  const png = decodePng(read(join(dir, 'a.png')));
  assert.deepEqual([...png.rgba.slice((png.width * 40 + 40) * 4, (png.width * 40 + 40) * 4 + 4)], [255, 255, 255, 255]);
  const split = run(spec, '-o', join(dir, 'b.svg'), '--theme', 'split', '--palette', 'ebony');
  assert.equal(split.status, 0, split.stderr);
  assert.ok(read(join(dir, 'b.dark.svg'), 'utf8').includes(EBONY_DARK.bg));
  assert.equal(run(spec, '-o', join(dir, 'c.svg'), '--palette', 'pink').status, 2);
  assert.match(run(spec, '-o', join(dir, 'c.svg'), '--background', 'clear').stderr, /--background must be one of solid, transparent/);
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

test('fit: a flow starts at the top left, keeps its words when they fit, and stays inside the page width', async () => {
  const { render, toLegend, MAX_WIDTH } = await import('../src/diagram/index.ts');
  const { judge } = await import('../src/diagram/fit.ts');
  const flow = await render(example('dynamic'));
  assert.ok(flow.width <= MAX_WIDTH, `${flow.width}`);
  assert.equal(flow.report.passed, true);
  assert.equal(flow.numbered, false);
  assert.match(flow.svg, />1\. Submits the checkout/);
  // Step 1 leaves the element nearest the top left, in either direction.
  for (const direction of ['DOWN', 'RIGHT'] as const) {
    const l = (await judge(example('dynamic'), { direction })).layout;
    const first = l.edges.find((e) => e.rel.order === 1)!;
    const from = l.nodes.find((b) => b.el.id === first.rel.from)!;
    for (const b of l.nodes) if (!b.group) assert.ok(direction === 'DOWN' ? from.y <= b.y : from.x <= b.x, `${direction}: ${b.el.id} is before the first step`);
  }
  const numbered = await render(example('dynamic'), { labels: 'numbered' });
  assert.match(numbered.svg, /class="en"[^>]*>1</);
  const legend = toLegend(example('dynamic'));
  assert.match(legend, /^\| # \| From \| To \| What \| How \|/);
  assert.match(legend, /\| 1 \| Shopper \| Storefront \| Submits the checkout form \| `HTTPS` \|/);
  const forced = await render(example('dynamic'), { labels: 'text', direction: 'RIGHT' });
  assert.equal(forced.numbered, false);
  assert.equal(forced.direction, 'RIGHT');
  assert.ok(forced.report.candidates.every((c) => c.direction === 'RIGHT' && c.labels === 'text'), 'what the caller names is never overridden');
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

test('layout: a group is as wide as its title, the title is never cut, and no line runs through it', async () => {
  const { measure } = await import('../src/diagram/judge.ts');
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
      assert.ok(b.title && inside(b.title, b), `${l.direction} ${id}: the title is inside its group`);
      assert.ok(b.title.w >= Math.min(groupLabelWidth(b.el), textWidth(b.el.name, 13, true)) - 1, `${l.direction} ${id}: the title has the room its words need`);
      if (b.badge) {
        assert.ok(inside(b.badge, b), `${id} badge is inside the group`);
        assert.ok(b.badge.x >= b.title.x + b.title.w, `${id} badge is clear of the title`);
      }
    }
    assert.ok(inside(box(l, 'in'), box(l, 'g')), 'a group fits inside its parent');
    assert.deepEqual([measure(l).titles, measure(l).clipped], [0, 0]);
  }
  for (const direction of ['DOWN', 'RIGHT'] as const) {
    const svg = await renderSvg(spec, { direction });
    assertWellFormed(svg);
    assert.doesNotMatch(svg, /\u2026/);
    // A long title puts the kind under the name.
    assert.ok(svg.includes(`>${name}</text><text class="gk"`), 'the long name is whole, with its kind under it');
    assert.ok(svg.includes('>Primary database cluster node group in Frankfurt<'));
    assert.ok(svg.includes('>An empty zone with a rather long name as well<'));
  }
  // The layout engine places a title as it places a box. So in every layout of the nested specs, both ways,
  // with words or numbers, no line runs through the name of a group.
  for (const nested of [pressure('04-nested'), pressure('n15-deployment'), pressure('09-statuses'), example('in-process'), example('change-impact')]) {
    for (const l of await layouts(nested)) {
      for (const g of l.nodes.filter((b) => b.group)) {
        assert.ok(g.title && inside(g.title, g), `${nested.title} ${l.direction}: the name of ${g.el.id} is inside it`);
        for (const e of l.edges) assert.ok(!crossesRect(e.points, g.title, 1), `${nested.title} ${l.direction}: ${e.rel.from} -> ${e.rel.to} runs through the name of ${g.el.id}`);
      }
    }
  }
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
  let checked = 0;
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
      assert.ok(Math.max(bounds.w, bounds.h) >= 24 && Math.min(bounds.w, bounds.h) >= 16, `${where} loop is ${bounds.w} x ${bounds.h}`);
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

test('judge: every example passes every gate it can, with short lines and few corners', async () => {
  const { judge } = await import('../src/diagram/fit.ts');
  const specs: [string, DiagramSpec][] = [
    ...['context', 'container', 'change-impact', 'dynamic', 'focused', 'in-process', 'code', 'whole-system'].map((n): [string, DiagramSpec] => [n, example(n)]),
    ['five components', fixture('diagram-five-components')], ['containers', fixture('diagram-containers')],
  ];
  for (const [name, spec] of specs) {
    const { report } = await judge(spec);
    const c = report.candidates.find((k) => k.chosen)!;
    // The whole map is past the budget of a container diagram: it is the one example no rung fits, and it says so.
    assert.equal(report.passed, name !== 'whole-system', `${name}: ${report.why}`);
    assert.deepEqual(c.fails.filter((g) => g !== 'width' && g !== 'height'), [], name);
    assert.ok(c.longest <= 1.2, `${name}: a line is ${c.longest} times the diagonal`);
    assert.ok(c.maxBends <= 6, `${name}: a line has ${c.maxBends} corners`);
    assert.ok(c.bends <= c.lines * 3, `${name}: ${c.bends} corners on ${c.lines} lines`);
    assert.ok(c.detour <= c.lines * 160, `${name}: ${c.detour}px of detour on ${c.lines} lines`);
    assert.ok(c.crossings <= Math.max(2, c.lines / 4), `${name}: ${c.crossings} crossings on ${c.lines} lines`);
    if (name === 'whole-system') continue;
    assert.deepEqual([c.broken, c.through, c.titles, c.struck, c.overlaps, c.clipped], [0, 0, 0, 0, 0, 0], name);
    // The examples are the good cases: none draws a warning about its lines. A few are tall, and say so.
    const allowed = (w: string): boolean => w.includes('is wider than') || w.includes('px tall');
    assert.deepEqual(report.warnings.filter((w) => !allowed(w)), [], name);
  }
});

test('judge: a direction, a label mode and a level of detail that are named are never overridden', async () => {
  const { render } = await import('../src/diagram/svg.ts');
  const { advise } = await import('../src/diagram/advise.ts');
  // A spec that names left to right where that is far too wide is drawn left to right, and the report says no rung fits.
  const named: DiagramSpec = { ...pressure('wide-right'), direction: 'RIGHT' };
  const pinned = await render(named);
  assert.equal(pinned.direction, 'RIGHT');
  assert.ok(pinned.report.candidates.every((k) => k.direction === 'RIGHT'));
  assert.equal(pinned.report.passed, false);
  assert.match(pinned.report.why, /^no layout passes every check on any of the \d+ rungs\. Drew the nearest: left to right/);
  assert.match(pinned.report.warnings[0]!, /is wider than GitHub's 860px body/);
  // With nothing passing, the width decides before the calm: GitHub scales a wide image down, so the narrowest is drawn.
  const over = (k: { width: number }): number => Math.ceil(Math.max(0, k.width - 860) / 100);
  assert.equal(over(pinned.report.candidates.find((k) => k.chosen)!), Math.min(...pinned.report.candidates.map(over)));
  // Taking the direction out of the spec is the fix, and it was tried before it is offered.
  const fixes = (await advise(named, {}, pinned.report)).fixes;
  assert.ok(fixes.some((f) => f.command === 'graph set --direction ""' && f.width <= 860), fixes.map((f) => f.command).join('|'));
  const out = await render(fixture('diagram-three-groups'));
  assert.deepEqual([out.direction, out.report.passed, out.width <= 860], ['DOWN', true, true]);
  for (const opts of [{ labels: 'text' as const }, { labels: 'numbered' as const }, { detail: 'full' as const }, { detail: 'compact' as const }, { direction: 'RIGHT' as const }, { direction: 'DOWN' as const }]) {
    const r = await render(fixture('diagram-containers'), opts);
    for (const k of r.report.candidates) {
      if ('labels' in opts) assert.equal(k.labels, opts.labels);
      if ('direction' in opts) assert.equal(k.direction, opts.direction);
      if ('detail' in opts && opts.detail === 'compact') assert.equal(k.compact, true);
    }
  }
});

test('judge: the gates, the rank among layouts that pass, and the faults in words', async () => {
  const { compare, failed, faults, rank } = await import('../src/diagram/judge.ts');
  const calm = { lines: 4, broken: 0, length: 800, detour: 0, longest: 0.3, bends: 4, maxBends: 2, crossings: 0, roundabout: 0, calmCrossings: 0, calmAllowed: 1, through: 0, titles: 0, struck: 0, overlaps: 0, clipped: 0 };
  const page = { width: 860, height: 1376 };
  assert.deepEqual(failed(calm, { width: 860, height: 1376 }, page), []);
  assert.deepEqual(failed({ ...calm, broken: 1, titles: 1, overlaps: 1 }, { width: 861, height: 1377 }, page), ['lines', 'text', 'overlap', 'width', 'height']);
  assert.deepEqual(failed({ ...calm, through: 1 }, page, page), ['text']);
  assert.deepEqual(failed({ ...calm, struck: 1 }, page, page), ['text']);
  assert.deepEqual(failed({ ...calm, clipped: 1 }, page, page), ['overlap']);
  // Crossings come first, then detour, then corners. The shape only breaks a tie: it never buys a crossing.
  const golden = rank(calm, 800, 500), tall = rank(calm, 400, 1200);
  assert.ok(compare(golden, tall) < 0);
  assert.ok(compare(rank({ ...calm, crossings: 1 }, 800, 500), tall) > 0);
  assert.ok(compare(rank({ ...calm, detour: 400 }, 800, 500), tall) > 0);
  assert.ok(compare(rank({ ...calm, crossings: 1 }, 800, 500), rank({ ...calm, detour: 4000, bends: 40 }, 800, 500)) > 0);
  assert.deepEqual(faults(calm, (id) => id), []);
  const poor = faults({ ...calm, broken: 1, crossings: 3, through: 1, overlaps: 2, titles: 1, struck: 1, clipped: 1, worst: { from: 'a', to: 'b', length: 1900, direct: 300 } }, (id) => id.toUpperCase());
  assert.deepEqual(poor, [
    '1 relationship is not drawn from end to end',
    'the line from "A" to "B" runs 1900px where 300px would join them',
    '1 line passes through a box that is not theirs',
    '1 line runs through the name of a group',
    '1 line runs through a label or a badge',
    '2 places where a label lies on a label or a box, or one line lies on another',
    '1 group is narrower than its name',
    '3 line crossings on 4 lines',
  ]);
  // A fault states what is wrong. A fix is printed by the tool only after it was tried.
  assert.doesNotMatch(poor.join(' '), /graph |--labels/);
  // One crossing for every four lines is calm. More is a fault, and fails the calm gate.
  assert.deepEqual(faults({ ...calm, crossings: 1 }, (id) => id), []);
  assert.deepEqual(faults({ ...calm, crossings: 2, calmCrossings: 2 }, (id) => id), ['2 line crossings on 4 lines']);
  assert.deepEqual(failed({ ...calm, crossings: 2, calmCrossings: 2 }, page, page), ['calm']);
  assert.deepEqual(failed({ ...calm, roundabout: 1 }, page, page), ['calm']);
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
  const steps = await render(flow, { labels: 'numbered' });
  assert.equal(steps.numbered, true);
  assert.deepEqual(drawn(steps.svg), flow.relationships.map((r) => r.order));
  assert.deepEqual(rows(flow).map((r) => Number(r[0])), [1, 2, 3, 4, 5, 6, 7]);
  const names = new Map(flow.elements.map((e) => [e.id, e.name]));
  for (const r of flow.relationships) assert.deepEqual(rows(flow)[r.order! - 1]!.slice(1, 4), [names.get(r.from), names.get(r.to), r.label]);
});

test('code: a file is a card with a row per symbol, and a line ends on the row it names', async () => {
  const spec = example('code');
  assert.deepEqual(lintSpec(spec), { errors: [], warnings: [] });
  const l = await layout(spec, { direction: 'RIGHT' });
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
    // No two lines end on one point: each can be followed to its row. Lines that leave one file together may share their start.
    for (const o of l.edges) if (o !== e) assert.ok(Math.hypot(o.points.at(-1)!.x - tip.x, o.points.at(-1)!.y - tip.y) > 2, `${e.rel.from} and ${o.rel.from} end on one point of ${e.rel.to}`);
    assert.equal(e.label, undefined);
    for (const b of l.nodes) if (b !== to && b !== from && !b.group) assert.ok(!crossesRect(e.points, b, -1), `${e.rel.from} -> ${e.rel.to} crosses ${b.el.id}`);
  }
  const files = l.nodes.filter((b) => b.card);
  for (const a of files) for (const b of files) if (a !== b) assert.ok(!overlap(a, b), `${a.el.id} overlaps ${b.el.id}`);

  const { render } = await import('../src/diagram/svg.ts');
  const { measure } = await import('../src/diagram/judge.ts');
  const out = await render(spec);
  // A code diagram has one form: layers of files by import depth, left to right. Three layers fit the page.
  assert.deepEqual([out.direction, out.numbered, out.report.passed, out.report.rung, out.report.rungs], ['RIGHT', false, true, 1, 1]);
  assert.ok(out.width <= 860 && out.height <= 520, `${out.width} x ${out.height}`);
  const xs = (ids: string[]): number[] => ids.map((id) => box(out.layout, id).x);
  // What imports the change, the change, and what the change imports: each layer is a column to the right of the one before.
  assert.ok(Math.max(...xs(['checkout', 'retry'])) < Math.min(...xs(['authorise', 'lib'])) && Math.max(...xs(['authorise', 'lib'])) < box(out.layout, 'keys').x, JSON.stringify(out.layout.nodes.map((b) => [b.el.id, Math.round(b.x)])));
  // A group takes no room: its name is on each of its cards, and no band is drawn.
  assert.ok(out.layout.nodes.every((b) => !b.group));
  assert.equal(box(out.layout, 'retry').card!.lane, 'PAYMENT SERVICE');
  assert.match(out.svg, /class="ln"[^>]*>ORDER SERVICE</);
  assert.equal(measure(out.layout).broken, 0, 'every line ends on the row it names');
  // Two files that import each other stand in one layer, and the lines between them run beside the cards, on their right.
  const knot = structuredClone(spec);
  knot.relationships.push({ from: 'keys', to: 'authorise', toSymbol: 'authorise', label: '' });
  const tied = await render(knot);
  assert.equal(tied.report.passed, true, tied.report.why);
  const [a, k] = [box(tied.layout, 'authorise'), box(tied.layout, 'keys')];
  assert.ok(a.x < k.x + k.w && k.x < a.x + a.w && (a.y >= k.y + k.h || k.y >= a.y + a.h), 'the two files of the cycle share a column, one above the other');
  for (const e of tied.layout.edges.filter((x) => [x.rel.from, x.rel.to].sort().join() === 'authorise,keys')) {
    assert.ok(Math.abs(e.points[0]!.x - (a.x + Math.max(a.w, k.w))) < Math.max(a.w, k.w) && e.points.every((pt) => pt.x >= Math.min(a.x + a.w, k.x + k.w) - 1), 'the line stays to the right of the two cards');
    const span = Math.max(...e.points.map((pt) => pt.x)) - Math.min(...e.points.map((pt) => pt.x));
    assert.ok(span < 80, `the line turns beside the cards, ${Math.round(span)}px out`);
  }
  assertWellFormed(out.svg);
  assert.match(out.svg, /^<svg[^>]*><title[^>]*>Payment retries move to idempotency keys: Code diagram for/);
  // Path, symbol names, kinds, and the same marks the lines use. A removed symbol is struck through.
  for (const text of ['>idempotency.rs<', '>services/payments/src/<', '>retry_authorisation<', '>struct<', 'class="sm m-added"', 'class="sm m-changed"', 'class="sm m-removed"', 'class="sm m-affected"']) {
    assert.ok(out.svg.includes(text), text);
  }
  assert.match(out.svg, /<g class="gone"><text class="sy"[^>]*>backoff_schedule<\/text>.*?class="strike"/);
  const key = out.svg.slice(out.svg.indexOf('>KEY<'));
  assert.match(key, />File<.*>NAME<.*>Part of the system<.*>Imports<.*>Added<.*>Changed<.*>Removed<.*>Imports a changed signature</);
  assert.doesNotMatch(key, /Boundary|Relationship|ADDED/);
  for (const theme of ['light', 'dark'] as const) assert.doesNotMatch(await renderSvg(spec, { theme }), /var\(--/);

  // A direction that is named is kept, wide or not.
  const right = await render(spec, { direction: 'RIGHT' });
  assert.equal(right.direction, 'RIGHT');
  assertWellFormed(right.svg);
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
  const spec = fileURLToPath(new URL('./fixtures/diagram-five-components.json', import.meta.url));
  const plain = run(spec, '-o', join(dir, 'a.svg'));
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout.trim(), join(dir, 'a.svg'));
  assert.match(plain.stderr, /^\d+ x \d+px, top down$/m);
  assert.match(plain.stderr, /^layout: kept top down, words on the lines: rung 1 of \d+$/m);
  const out = run(spec, '-o', join(dir, 'b.svg'), '--png', join(dir, 'b.png'), '--report');
  assert.equal(out.status, 0, out.stderr);
  const report = JSON.parse(out.stdout) as { svg: string; png: string; width: number; direction: string; labels: string; why: string; warnings: string[]; rung: number; rungs: number; passed: boolean; candidates: { chosen: boolean; direction: string; rung: number; fails: string[]; detour: number }[] };
  assert.deepEqual([report.svg, report.png, report.direction, report.labels], [join(dir, 'b.svg'), join(dir, 'b.png'), 'DOWN', 'text']);
  assert.ok(report.width <= 860 && report.why.startsWith('kept top down'));
  assert.deepEqual([report.rung, report.passed], [1, true]);
  assert.ok(report.rungs >= report.rung);
  const kept = report.candidates.filter((c) => c.chosen);
  assert.equal(kept.length, 1);
  assert.deepEqual([kept[0]!.rung, kept[0]!.fails], [1, []]);
  // A spec that no rung fits is still drawn, and the layout line says so before the warnings.
  const wide = run(fileURLToPath(new URL('./fixtures/pressure/wide-right.json', import.meta.url)), '-o', join(dir, 'c.svg'), '--direction', 'right');
  assert.equal(wide.status, 0, wide.stderr);
  assert.match(wide.stderr, /^layout: no layout passes every check on any of the \d+ rungs\. Drew the nearest: left to right/m);
  assert.match(wide.stderr, /^warning: \d+px is wider than GitHub's 860px body/m);
  assert.match(wide.stderr, /^fix: no --direction right gives \d+ x \d+px with (no warning|\d warnings?, where there (was 1|were \d))\.$/m);
  assert.equal(run(spec, '--report', '-o', '-').status, 2);
});

const pressure = (name: string): DiagramSpec =>
  JSON.parse(readFileSync(new URL(`./fixtures/pressure/${name}.json`, import.meta.url), 'utf8')) as DiagramSpec;

test('judge: a layout that drops a line or leaves one hanging is never kept', async () => {
  const { judge } = await import('../src/diagram/fit.ts');
  const { measure } = await import('../src/diagram/judge.ts');
  // ELK gives no route for some lines once it wraps a graph that has a line going back. The gate sees it.
  const dropped = { ...(await layout(pressure('08-cycle'), { direction: 'DOWN' })) };
  dropped.edges = dropped.edges.map((e, i) => (i === 0 ? { ...e, points: [] } : e));
  assert.equal(measure(dropped).broken, 1);
  const hanging = await layout(pressure('08-cycle'), { direction: 'DOWN' });
  hanging.edges[0]!.points.at(-1)!.y += 40;
  assert.equal(measure(hanging).broken, 1);
  const cases: [string, 'RIGHT' | 'DOWN' | undefined][] = [
    ['08-cycle', undefined], ['08-cycle', 'RIGHT'], ['05-long-fix-title', undefined], ['06-dynamic8', 'RIGHT'], ['09-statuses', 'RIGHT'], ['11-code-symrefs-ok', undefined],
  ];
  for (const [name, direction] of cases) {
    const spec = pressure(name);
    const { layout: kept, report } = await judge(spec, direction ? { direction } : {});
    const c = report.candidates.find((k) => k.chosen)!;
    const where = `${name} ${direction ?? 'auto'}`;
    assert.equal(c.broken, 0, where);
    assert.equal(kept.edges.filter((e) => e.points.length > 1).length, spec.relationships.length, `${where}: every relationship is drawn`);
    assert.ok(report.candidates.every((k) => !k.chosen || !k.fails.includes('lines')));
  }
});

test('judge: a flow starts on its first step, the first relationship sets the reading order, lines do not lie on one another', async () => {
  const { judge } = await import('../src/diagram/fit.ts');
  const flow = await judge(pressure('08-self-dynamic'));
  const first = flow.layout.edges.find((e) => e.rel.order === 1)!;
  assert.ok(first.points[0]!.x < first.points.at(-1)!.x || first.points[0]!.y < first.points.at(-1)!.y, 'step 1 runs forward');
  // A flow with a group draws, both ways.
  for (const direction of ['DOWN', 'RIGHT'] as const) assert.equal((await judge(pressure('m1-flow-group'), { direction })).report.candidates[0]!.broken, 0);
  // In a cycle the line that returns to the start is the one drawn backwards, whatever order the elements are listed in.
  const cycle = pressure('08-cycle');
  for (const elements of [cycle.elements, [...cycle.elements].reverse()]) {
    const l = (await judge({ ...cycle, elements }, { direction: 'DOWN' })).layout;
    const y = (id: string): number => box(l, id).y;
    const [a, b] = [cycle.relationships[0]!.from, cycle.relationships[0]!.to];
    assert.ok(y(a) < y(b), 'the first relationship runs down');
    const last = cycle.relationships.at(-1)!;
    assert.ok(y(last.to) < y(last.from), 'the relationship that closes the cycle runs back up');
  }
  const refs = (await judge(pressure('11-code-symrefs-ok'))).report.candidates.find((k) => k.chosen)!;
  assert.deepEqual([refs.overlaps, refs.broken], [0, 0]);
});

test('judge: height is warned about, and a fix is printed only after the tool tried it and it helped', async () => {
  const { judge } = await import('../src/diagram/fit.ts');
  const { advise } = await import('../src/diagram/advise.ts');
  const tall = (await judge(pressure('11-code8x6'))).report;
  assert.match(tall.warnings.join('\n'), /the image is \d+px tall/);
  // Forcing a chain across two groups left to right makes it too wide. Dropping the option is the fix, and it was judged.
  const forced = { direction: 'RIGHT' as const };
  const wide = (await judge(pressure('wide-right'), forced)).report;
  assert.match(wide.warnings[0]!, /is wider than GitHub's 860px body/);
  const advice = await advise(pressure('wide-right'), forced, wide);
  assert.deepEqual(advice.fixes.map((f) => [f.command, f.warnings]), [['no --direction right', []]]);
  // Eight files that import one another in a ring are spread over the three layers. What is left past the budget of lines
  // is mended by dropping the two files the change only reaches, and that fix was drawn before it is offered.
  const ring = await advise(pressure('11-code8x6'), {}, tall);
  assert.deepEqual(ring.fixes.map((f) => [f.command, f.warnings]), [['graph drop --status affected', []]]);
  // A warning never names a filter or an option. That is the job of a fix line.
  for (const w of [...tall.warnings, ...wide.warnings]) assert.doesNotMatch(w, /graph |--labels|--direction/);
  // Numbers already on the lines are never offered as the cure.
  const numbered = (await judge(pressure('09-statuses'), { direction: 'RIGHT', labels: 'numbered' })).report;
  assert.doesNotMatch(numbered.warnings.join(' '), /numbered/);
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

test('round 3: sizes are the whole image everywhere, and a fix never cuts the change or hides what it removes', async () => {
  const { render } = await import('../src/diagram/svg.ts');
  const { advise } = await import('../src/diagram/advise.ts');
  const { drop } = await import('../src/graph/ops.ts');
  // The height in the warning is the height on the size line.
  const tall = await render(pressure('11-code8x6'));
  assert.ok(tall.report.warnings.includes(`the image is ${tall.height}px tall, so a reader scrolls to follow a line`), tall.report.warnings.join('|'));
  const kept = tall.report.candidates.find((c) => c.chosen)!;
  assert.deepEqual([kept.width, kept.height], [tall.width, tall.height]);
  // An image between 900 and 1100px is warned about: the limit is on what the reader sees.
  const mid = await render(pressure('04-nested'));
  assert.ok(mid.height > 900 && mid.report.warnings.some((w) => w.includes('px tall')), `${mid.height}`);
  // The size in a fix line is the size you get when you apply it.
  const forced = { direction: 'RIGHT' as const };
  const wide = await render(pressure('wide-right'), forced);
  const fix = (await advise(pressure('wide-right'), forced, wide.report)).fixes[0]!;
  const applied = await render(pressure('wide-right'));
  assert.deepEqual([fix.command, fix.width, fix.height], ['no --direction right', applied.width, applied.height]);
  // The deployment spec: dropping what is unchanged would take two of the three added lines with it. That fix is not offered.
  const spec = pressure('n15-deployment');
  const advice = await advise(spec, {}, (await render(spec)).report);
  assert.ok(advice.fixes.every((f) => !f.command.startsWith('graph drop --status')), advice.fixes.map((f) => f.command).join('|'));
  assert.ok(!advice.tried.includes('graph drop --status unchanged --orphans'), 'a filter that cuts the change is not even tried');
  // What a fix removes is said in words.
  const marked = base();
  marked.elements.push({ id: 'old', type: 'container', name: 'Old', technology: 'x', description: 'd' });
  marked.elements[0]!.status = 'changed';
  marked.elements[1]!.status = 'changed';
  marked.relationships.push({ from: 'old', to: 'api', label: 'Reads from', technology: 'HTTPS' });
  const crowded = { why: '', rung: 1, rungs: 1, passed: true, warnings: ['a', 'b', 'c'], candidates: [] };
  const offered = (await advise(marked, {}, crowded)).fixes.find((f) => f.command.startsWith('graph drop'));
  assert.match(offered!.removes, /^removes 1 unchanged element \("Old"\) and 1 unchanged line$/);
  // `graph drop` leaves no empty group, and the scope line of a code diagram says cards were taken out.
  const code = example('code');
  const cut = drop(code, { ids: ['checkout'] });
  assert.ok(!cut.elements.some((e) => e.id === 'orders'), 'the group that held only the dropped card is gone');
  assert.match(cut.scope!, /\. 1 card removed by hand$/);
  assert.match(drop(cut, { ids: ['lib'] }).scope!, /\. 2 cards removed by hand$/);
});

test('round 3: a container that holds elements is a group in the key, and a boundary is a boundary', async () => {
  const { render } = await import('../src/diagram/svg.ts');
  assert.match((await render(example('container'))).svg, />Group</);
  assert.match((await render(pressure('04-nested'))).svg, />Boundary</);
});

test('round 3: lint names the field that is wrong, refuses a person or a file as parent, and warns on a key it does not read', () => {
  const run = (change: (s: any) => void): string => { const s: any = base(); change(s); const r = lintSpec(s); return [...r.errors.map((e) => `error: ${e}`), ...r.warnings.map((w) => `warning: ${w}`)].join('\n'); };
  assert.equal(run((s) => { s.elements[0].kind = 12; }), 'error: element "web": kind must be text');
  assert.match(run((s) => { s.elements[0].name = 'x'.repeat(10000); }), /error: element "web": name is 10000 characters; keep it under 120/);
  assert.match(run((s) => { s.elements[0].type = 'person'; s.elements[1].parent = 'web'; }), /error: element "api" has parent "web", which is a person; only a boundary, node, system, container or component holds other elements/);
  assert.equal(run((s) => { s.elements[1].parent = 'web'; s.relationships = []; }), '', 'a container may hold elements: collapse and the map rely on it');
  assert.match(run((s) => { s.titel = 'x'; s.elements[0].parrent = 'api'; s.relationships[0].lable = 'x'; }), /the spec has the key "titel"[\s\S]*element "web" has the key "parrent"[\s\S]*relationships\[0\] has the key "lable"/);
  assert.equal(run((s) => { s.detail = 'huge'; }), 'error: detail must be one of auto, full, compact');
  assert.equal(run((s) => { s.elements[0].external = 'yes'; }), 'error: element "web": external must be true or false');
  assert.equal(run((s) => { s.elements[0].technology = ['Rust']; }), 'error: element "web": technology must be text');
  assert.equal(run((s) => { s.relationships[0].label = { text: 'x' }; }), 'error: relationship web -> api: label must be text');
  assert.equal(run((s) => { delete s.relationships[0].from; }), 'error: relationships[0] has no from');
  assert.equal(run((s) => { s.relationships[0].to = 7; }), 'error: relationships[0]: to must be text, the id of an element');
  // One bad id is one error: the relationships that name it are not reported as well.
  assert.equal(run((s) => { delete s.elements[1].id; }), 'error: elements[1] has no id');
  assert.equal(run((s) => { s.elements[1].id = 'web'; }), 'error: element id "web" is used more than once');
});

test('round 3: the command refuses --mermaid with --png, says a write failure plainly, and reads a spec that starts with a byte order mark', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dir = mkdtempSync(join(tmpdir(), 'wat-r3-'));
  const run = (...args: string[]) => spawnSync(process.execPath, [fileURLToPath(new URL('./diagram-run.ts', import.meta.url)), ...args], { encoding: 'utf8' });
  const spec = join(dir, 'bom.json');
  writeFileSync(spec, `﻿${JSON.stringify(base())}`);
  const ok = run(spec, '-o', join(dir, 'a.svg'));
  assert.equal(ok.status, 0, ok.stderr);
  // The first stderr line is the size of the image that was written.
  assert.match(ok.stderr, /^\d+ x \d+px, /);
  const mermaid = run(spec, '--mermaid', '--png', join(dir, 'a.png'));
  assert.deepEqual([mermaid.status, mermaid.stdout], [2, '']);
  assert.match(mermaid.stderr, /--mermaid prints text and draws nothing/);
  const lost = run(spec, '-o', join(dir, 'no-such-folder', 'a.svg'));
  assert.equal(lost.status, 2);
  assert.match(lost.stderr, /cannot write ".*a\.svg": its folder does not exist/);
  assert.doesNotMatch(lost.stderr, /ENOENT/);
});

test('code shape: files stand in layers by import depth, a cycle is spread over the layers to spare, and three layers are kept round the first file', async () => {
  const { codeShape } = await import('../src/diagram/code-shape.ts');
  const { over, codeCut, trim } = await import('../src/diagram/budget.ts');
  const { judge } = await import('../src/diagram/fit.ts');
  const file = (id: string, status?: 'changed'): DiagramSpec['elements'][number] => ({ id, type: 'file', name: `src/${id}.ts`, ...(status ? { status } : {}) });
  const line = (from: string, to: string): DiagramSpec['relationships'][number] => ({ from, to, label: '' });
  const spec = (elements: DiagramSpec['elements'], relationships: DiagramSpec['relationships']): DiagramSpec => ({ title: 'T', type: 'code', elements, relationships });
  // A chain, a file that imports the end of it, and a file with no line.
  const chain = codeShape(spec(['a', 'b', 'c', 'late', 'alone'].map((id) => file(id)), [line('a', 'b'), line('b', 'c'), line('late', 'c')]));
  assert.deepEqual([...chain.layer], [['a', 0], ['b', 1], ['c', 2], ['late', 1], ['alone', 0]], 'a file stands just left of what it imports, and a file with no line in the shortest layer');
  assert.deepEqual([chain.layers, chain.depth, chain.beyond], [3, 3, []]);
  // Two files that import each other are a knot. With a layer to spare it is spread over two, in the order that leaves
  // the fewest imports running back; kept whole it shares one.
  const cycle = spec(['a', 'b', 'c'].map((id) => file(id)), [line('a', 'b'), line('b', 'c'), line('c', 'b')]);
  const knot = codeShape(cycle);
  assert.deepEqual([knot.layer.get('a'), knot.layer.get('b'), knot.layer.get('c'), knot.depth], [0, 1, 2, 3]);
  const whole = codeShape(cycle, undefined, undefined, false);
  assert.deepEqual([whole.layer.get('b'), whole.layer.get('c'), whole.depth], [1, 1, 2]);
  // A knot is never spread past the three layers: four files in a ring after one that imports them stay in two.
  const ring = codeShape(spec(['x', 'p', 'q', 'r', 's'].map((id) => file(id)), [line('x', 'p'), line('p', 'q'), line('q', 'r'), line('r', 's'), line('s', 'p')]));
  assert.deepEqual([ring.depth, ring.beyond], [3, []]);
  // Five deep: the three layers that hold the first file are drawn, and lint names the files to drop.
  const deep = spec([file('c', 'changed'), file('a'), file('b'), file('d'), file('e')], [line('a', 'b'), line('b', 'c'), line('c', 'd'), line('d', 'e')]);
  const shape = codeShape(deep);
  assert.deepEqual([shape.depth, shape.layers, shape.layer.get('c'), shape.beyond.sort()], [5, 3, 2, ['d', 'e']]);
  assert.deepEqual(over(deep), ['imports 5 files deep is more than the 3 layers a code diagram holds']);
  assert.deepEqual(codeCut(deep), ['d', 'e']);
  assert.match(lintSpec(deep).warnings.join('\n'), /imports 5 files deep is more than the 3 layers a code diagram holds; `graph drop --ids d,e` leaves 3 and 2/);
  assert.equal(trim(deep)!.command, 'graph drop --ids d,e');
  // Drawn as it is, no line runs backwards or round the drawing: each goes right or stays in its layer.
  const { layout: l, report } = await judge(deep);
  assert.deepEqual([l.direction, report.rungs, report.candidates.find((c) => c.chosen)!.worst], ['RIGHT', 1, undefined]);
  for (const e of l.edges) assert.ok(e.points.every((pt) => pt.x >= e.points[0]!.x - 1), `${e.rel.from} -> ${e.rel.to} runs back to the left`);
});

test('judge: a tall drawing gives way to a wrapped one only when the lines stay as calm, and with no rung passing the lines decide', async () => {
  const { judge } = await import('../src/diagram/fit.ts');
  // A chain of eight passes top down at over 900px. Wrapped it is nearer 1.6 to 1 with no crossing, and keeps its words.
  const chain = await judge(pressure('01-chain8'), { frame: undefined });
  const kept = chain.report.candidates.find((c) => c.chosen)!;
  assert.deepEqual([kept.wrapped, kept.labels, kept.crossings, chain.report.rung], [true, 'text', 0, 2]);
  assert.match(chain.report.why, /rung 1 \(as written\) passes at \d+px tall, and this one is nearer 1\.6 to 1 with lines as calm/);
  assert.ok(chain.report.candidates.some((c) => c.rung === 1 && !c.fails.length && c.height > 900));
  // Two groups with lines going back: wrapped, the lines cross. It stays tall, with its warning.
  const groups = await judge(pressure('n02-back-edge-groups'));
  assert.deepEqual([groups.report.rung, groups.report.candidates.find((c) => c.chosen)!.wrapped], [1, false]);
  assert.match(groups.report.warnings.join('\n'), /px tall/);
});
