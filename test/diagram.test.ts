import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lintSpec, renderSvg, toMermaid } from '../src/diagram/index.ts';
import { fit, textWidth, wrap } from '../src/diagram/measure.ts';
import { DARK, FILLS, LIGHT, STATUS_COLOURS, contrast } from '../src/diagram/theme.ts';
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
  for (const name of ['context', 'container', 'change-impact', 'dynamic', 'whole-system', 'focused']) {
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
  assert.match(plain, />Person<.*>Container<.*>Data Store<.*>Queue<.*>External<.*>Boundary<.*>Relationship/);
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
