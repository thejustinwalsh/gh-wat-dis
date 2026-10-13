import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError } from '../src/cli/util.ts';
import { lintSpec } from '../src/diagram/index.ts';
import { collapse, diff, drop, focus, ids, merge, mergeStatus, rename, select, set, stats } from '../src/graph/index.ts';
import type { SetOptions } from '../src/graph/index.ts';
import type { DiagramSpec, SpecElement, SpecRelationship, Status } from '../src/spec.ts';

const el = (id: string, type: SpecElement['type'], extra: Partial<SpecElement> = {}): SpecElement =>
  ({ id, type, name: id.toUpperCase(), ...extra });
const rel = (from: string, to: string, label: string, extra: Partial<SpecRelationship> = {}): SpecRelationship =>
  ({ from, to, label, ...extra });

/** sys > (web > page, api > (handler, repo), db), user and mail outside. */
const big = (): DiagramSpec => ({
  title: 'Shop',
  type: 'component',
  elements: [
    el('user', 'person'),
    el('sys', 'system'),
    el('web', 'container', { parent: 'sys' }),
    el('page', 'component', { parent: 'web' }),
    el('api', 'container', { parent: 'sys' }),
    el('handler', 'component', { parent: 'api', status: 'changed' }),
    el('repo', 'component', { parent: 'api' }),
    el('db', 'datastore', { parent: 'sys' }),
    el('mail', 'system', { external: true }),
    el('lonely', 'system'),
  ],
  relationships: [
    rel('user', 'page', 'Clicks'),
    rel('page', 'handler', 'Posts orders', { technology: 'HTTPS' }),
    rel('page', 'repo', 'Reads prices', { technology: 'gRPC' }),
    rel('handler', 'repo', 'Saves orders'),
    rel('repo', 'db', 'Runs queries', { technology: 'SQL' }),
    rel('handler', 'mail', 'Sends receipts'),
  ],
});
const idsOf = (spec: DiagramSpec): string[] => spec.elements.map((e) => e.id);
const edges = (spec: DiagramSpec): string[] => spec.relationships.map((r) => `${r.from}>${r.to}`);

function assertValid(spec: DiagramSpec): void {
  const known = new Set(idsOf(spec));
  assert.equal(known.size, spec.elements.length, 'duplicate ids');
  for (const e of spec.elements) if (e.parent !== undefined) assert.ok(known.has(e.parent), `parent ${e.parent}`);
  for (const r of spec.relationships) assert.ok(known.has(r.from) && known.has(r.to), `${r.from}>${r.to}`);
}

test('focus keeps neighbours within the hops and every ancestor', () => {
  const frozen = JSON.stringify(big());
  const input = big();
  const one = focus(input, { on: ['handler'] });
  assert.equal(JSON.stringify(input), frozen, 'input mutated');
  assert.deepEqual(idsOf(one), ['sys', 'web', 'page', 'api', 'handler', 'repo', 'mail']);
  assert.deepEqual(edges(one), ['page>handler', 'page>repo', 'handler>repo', 'handler>mail']);
  assertValid(one);
  assert.deepEqual(idsOf(focus(big(), { on: ['handler'], hops: 0 })), ['sys', 'api', 'handler']);
  assert.deepEqual(idsOf(focus(big(), { on: ['handler'], hops: 2 })), ['user', 'sys', 'web', 'page', 'api', 'handler', 'repo', 'db', 'mail']);
  assert.deepEqual(idsOf(focus(big(), { on: ['handler'], direction: 'in' })), ['sys', 'web', 'page', 'api', 'handler']);
  assert.deepEqual(idsOf(focus(big(), { on: ['handler'], direction: 'out' })), ['sys', 'api', 'handler', 'repo', 'mail']);
});

test('focus on a parent keeps what it contains', () => {
  assert.deepEqual(idsOf(focus(big(), { on: ['api'], hops: 0 })), ['sys', 'api', 'handler', 'repo']);
});

test('select resolves ids and status selectors', () => {
  assert.deepEqual(select(big(), 'web, db'), ['web', 'db']);
  assert.deepEqual(select(big(), 'status:changed,added'), ['handler']);
  const spec = big();
  spec.relationships[4]!.status = 'removed';
  assert.deepEqual(select(spec, 'status:removed'), ['repo', 'db']);
  assert.throws(() => select(big(), 'web,nope'), UsageError);
  assert.throws(() => select(big(), 'status:new'), UsageError);
  assert.throws(() => focus(big(), { on: ['nope'] }), UsageError);
});

test('collapse folds descendants in, re-points, and merges only relationships that say the same thing', () => {
  const frozen = JSON.stringify(big());
  const input = big();
  const out = collapse(input, { toType: 'container' });
  assert.equal(JSON.stringify(input), frozen, 'input mutated');
  assert.deepEqual(idsOf(out), ['user', 'sys', 'web', 'api', 'db', 'mail', 'lonely']);
  assert.deepEqual(edges(out), ['user>web', 'web>api', 'web>api', 'api>db', 'api>mail']);
  assert.deepEqual(out.relationships.slice(1, 3).map((r) => [r.label, r.technology]), [['Posts orders', 'HTTPS'], ['Reads prices', 'gRPC']], 'two different labels stay two lines');
  const same = collapse({ ...input, relationships: input.relationships.map((r) => ({ ...r, label: 'Calls' })) }, { toType: 'container' });
  assert.deepEqual(edges(same), ['user>web', 'web>api', 'api>db', 'api>mail'], 'the same label merges into one line');
  const api = out.elements.find((e) => e.id === 'api')!;
  assert.equal(api.meta?.collapsed, 2);
  assert.equal(api.status, 'changed');
  assert.equal(out.elements.find((e) => e.id === 'web')!.status, undefined);
  assertValid(out);
});

test('collapse --into: outermost wins, unknown ids are a usage error', () => {
  const out = collapse(big(), { into: ['sys', 'api'] });
  assert.deepEqual(idsOf(out), ['user', 'sys', 'mail', 'lonely']);
  assert.deepEqual(edges(out), ['user>sys', 'sys>mail']);
  assert.equal(out.elements[1]!.meta?.collapsed, 6);
  assert.throws(() => collapse(big(), { into: ['nope'] }), UsageError);
  assert.throws(() => collapse(big(), { toType: 'pod' }), UsageError);
  assert.deepEqual(collapse(big(), { into: ['db'] }), big());
});

test('collapse leaves parallel relationships it did not move', () => {
  const spec = big();
  spec.relationships.push(rel('handler', 'mail', 'Sends refunds'));
  const out = collapse(spec, { into: ['web'] });
  assert.deepEqual(out.relationships.filter((r) => r.to === 'mail').map((r) => r.label), ['Sends receipts', 'Sends refunds']);
});

test('merged status: unanimous wins, a mix is never removed or added', () => {
  const s = (...all: Status[]): Status => mergeStatus(all);
  assert.equal(s('removed', 'removed'), 'removed');
  assert.equal(s('added', 'added'), 'added');
  assert.equal(s('removed', 'unchanged'), 'changed');
  assert.equal(s('added', 'affected'), 'changed');
  assert.equal(s('changed', 'affected', 'unchanged'), 'changed');
  assert.equal(s('affected', 'unchanged'), 'affected');
  assert.equal(s(), 'unchanged');
  const spec = big();
  spec.relationships[1]!.status = 'removed';
  spec.relationships[2]!.status = 'removed';
  assert.equal(collapse(spec, { toType: 'container' }).relationships[1]!.status, 'removed');
});

test('drop removes elements with their relationships and frees their children', () => {
  const out = drop(big(), { ids: ['api'] });
  assert.equal(out.elements.find((e) => e.id === 'handler')!.parent, undefined);
  assert.deepEqual(edges(out), edges(big()));
  assertValid(out);
  assert.deepEqual(edges(drop(big(), { ids: ['repo'] })), ['user>page', 'page>handler', 'handler>mail']);
  assert.deepEqual(idsOf(drop(big(), { external: true })).includes('mail'), false);
  assert.deepEqual(idsOf(drop(big(), { type: ['component', 'person'] })), ['sys', 'web', 'api', 'db', 'mail', 'lonely']);
  assert.deepEqual(idsOf(drop(big(), { status: ['unchanged'] })), ['handler']);
  assertValid(drop(big(), { status: ['unchanged'] }));
  assert.throws(() => drop(big(), { ids: ['nope'] }), UsageError);
  assert.throws(() => drop(big(), { status: ['new'] }), UsageError);
});

test('drop --orphans runs after the other filters, to a fixed point', () => {
  assert.deepEqual(idsOf(drop(big(), { orphans: true })), idsOf(big()).filter((id) => id !== 'lonely'));
  const out = drop(big(), { ids: ['page', 'handler', 'repo'], orphans: true });
  assert.deepEqual(idsOf(out), []);
});

test('merge unions by id and by (from, to, label); later files win field by field', () => {
  const a = big();
  const b: DiagramSpec = {
    title: 'Other', type: 'container', scope: 'b',
    elements: [el('api', 'container', { technology: 'Rust' }), el('cache', 'datastore')],
    relationships: [rel('api', 'cache', 'Caches prices'), rel('repo', 'db', 'Runs queries', { status: 'changed' })],
  };
  const out = merge([a, b]);
  assert.equal(out.title, 'Shop');
  assert.equal(out.type, 'component');
  assert.equal(out.scope, 'b');
  assert.deepEqual(out.elements.find((e) => e.id === 'api'), { id: 'api', type: 'container', name: 'API', parent: 'sys', technology: 'Rust' });
  assert.equal(out.elements.length, a.elements.length + 1);
  assert.equal(out.relationships.length, a.relationships.length + 1);
  assert.deepEqual(out.relationships.find((r) => r.from === 'repo'), rel('repo', 'db', 'Runs queries', { technology: 'SQL', status: 'changed' }));
  assertValid(out);
  assertValid(merge([{ ...a, elements: [] }, { ...b, relationships: [rel('api', 'ghost', 'Dangles')] }]));
});

test('diff marks added, removed and changed, and keeps what was removed', () => {
  const head = big();
  head.elements = head.elements.filter((e) => e.id !== 'repo' && e.id !== 'lonely');
  head.elements.push(el('cache', 'datastore', { parent: 'sys' }));
  head.elements.find((e) => e.id === 'db')!.technology = 'PostgreSQL';
  head.elements.find((e) => e.id === 'page')!.parent = 'sys';
  head.relationships = head.relationships.filter((r) => r.from !== 'repo' && r.to !== 'repo');
  head.relationships.push(rel('handler', 'cache', 'Caches prices'));
  head.relationships[1]!.label = 'Submits orders';
  const out = diff(big(), head);
  const status = Object.fromEntries(out.elements.map((e) => [e.id, e.status]));
  assert.deepEqual(status, {
    user: undefined, sys: undefined, web: undefined, page: 'changed', api: undefined, handler: undefined,
    db: 'changed', mail: undefined, cache: 'added', repo: 'removed', lonely: 'removed',
  });
  assert.equal(out.elements.find((e) => e.id === 'repo')!.parent, 'api');
  assert.deepEqual(Object.fromEntries(out.relationships.map((r) => [`${r.from}>${r.to}`, r.status])), {
    'user>page': undefined, 'page>handler': 'changed', 'handler>mail': undefined, 'handler>cache': 'added',
    'page>repo': 'removed', 'handler>repo': 'removed', 'repo>db': 'removed',
  });
  assertValid(out);
  assert.deepEqual(stats(diff(big(), big())).byStatus, { unchanged: 10 });
});

test('set edits top-level fields, elements and relationships', () => {
  const top = set(big(), { title: 'New', type: 'container', scope: 'the shop', direction: 'RIGHT' });
  assert.deepEqual([top.title, top.type, top.scope, top.direction], ['New', 'container', 'the shop', 'RIGHT']);
  assert.equal(set(top, { scope: '' }).scope, undefined);
  const edited = set(big(), { element: 'handler', fields: { name: 'Order handler', status: '', external: 'true', parent: 'web' } });
  assert.deepEqual(edited.elements.find((e) => e.id === 'handler'), { id: 'handler', type: 'component', name: 'Order handler', parent: 'web', external: true });
  const r = set(big(), { relationship: 'repo:db', fields: { label: 'Queries', technology: '', order: '3', status: 'changed' } });
  assert.deepEqual(r.relationships[4], { from: 'repo', to: 'db', label: 'Queries', order: 3, status: 'changed' });
  const invalid: SetOptions[] = [
    { type: 'flow' }, { direction: 'UP' }, { element: 'nope', fields: { name: 'x' } },
    { element: 'api', fields: { id: 'x' } }, { element: 'api', fields: { name: '' } },
    { element: 'api', fields: { parent: 'nope' } }, { element: 'api', fields: { parent: 'handler' } },
    { element: 'api', fields: { status: 'new' } }, { relationship: 'db:repo', fields: { label: 'x' } },
    { relationship: 'repo:db', fields: { order: 'first' } }, { fields: { name: 'x' } },
  ];
  for (const bad of invalid) assert.throws(() => set(big(), bad), UsageError, JSON.stringify(bad));
});

test('rename changes the id everywhere', () => {
  const out = rename(big(), { from: 'api', to: 'order-api' });
  assert.equal(out.elements.find((e) => e.id === 'handler')!.parent, 'order-api');
  assert.equal(JSON.stringify(rename(big(), { from: 'handler', to: 'h' })).includes('"handler"'), false);
  assertValid(out);
  assert.throws(() => rename(big(), { from: 'nope', to: 'x' }), UsageError);
  assert.throws(() => rename(big(), { from: 'api', to: 'web' }), UsageError);
});

test('stats and ids', () => {
  assert.deepEqual(stats(big()), {
    elements: 10, relationships: 6,
    byType: { person: 1, system: 3, container: 2, component: 3, datastore: 1 },
    byStatus: { unchanged: 9, changed: 1 },
    maxDepth: 3, roots: 4,
  });
  assert.equal(ids(big()).split('\n')[5], 'handler\tcomponent\tchanged\tHANDLER');
});

test('every op survives a spec that already has dangling ids', () => {
  const broken = big();
  broken.elements[2]!.parent = 'ghost';
  broken.relationships.push(rel('page', 'ghost', 'Dangles'));
  for (const out of [
    focus(broken, { on: ['page'] }), collapse(broken, { toType: 'container' }), drop(broken, { orphans: true }),
    merge([broken, big()]), diff(broken, broken),
  ]) assertValid(out);
});

const runner = (name: string): string => `"${process.execPath}" "${fileURLToPath(new URL(`./${name}-run.ts`, import.meta.url))}"`;
const graph = runner('graph'), diagram = runner('diagram');
const wholeSystem = fileURLToPath(new URL('../examples/diagrams/whole-system.json', import.meta.url));

test('cli: focus | collapse | diagram', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-wat-dis-'));
  const out = join(dir, 'out.svg');
  const printed = execSync(
    `${graph} focus --on status:changed,added,removed --hops 1 < "${wholeSystem}" | ${graph} collapse --to-type container | ${diagram} -o "${out}"`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.equal(printed.trim(), out);
  const svg = readFileSync(out, 'utf8');
  assert.match(svg, /^<svg .*<\/svg>\n$/s);
  assert.match(svg, />Payment service<.*>~ CHANGED</s);
  assert.doesNotMatch(svg, />Idempotency store</);

  const spec = execSync(`${graph} focus --on status:changed,added,removed "${wholeSystem}" | ${graph} collapse --to-type container -`, { encoding: 'utf8' });
  const parsed = JSON.parse(spec) as DiagramSpec;
  assert.equal(spec, JSON.stringify(parsed, null, 2) + '\n');
  assertValid(parsed);
  assert.deepEqual(lintSpec(parsed).errors, []);
  assert.deepEqual(idsOf(parsed), ['checkout', 'orders', 'payments', 'inventory', 'orders-db']);
});

test('cli: exit codes, stdout and stderr', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gh-wat-dis-'));
  const file = join(dir, 'big.json');
  writeFileSync(file, JSON.stringify(big()));
  const run = (cmd: string, input?: string) => spawnSync(cmd, { shell: true, encoding: 'utf8', input });

  const unknown = run(`${graph} focus --on nope "${file}"`);
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stdout, '');
  assert.match(unknown.stderr, /unknown element id: nope/);
  assert.equal(run(`${graph} explode "${file}"`).status, 2);
  assert.equal(run(`${graph} focus "${file}"`).status, 2);
  assert.equal(run(`${graph} ids -`, 'not json').status, 2);
  assert.match(run(`${graph} --help`).stdout, /from-facts \[facts\.json\] \[--all\] \[--level file\]/);
  assert.match(run(`${diagram} --help`).stdout, /npx gh-wat-dis diagram/);

  assert.equal(run(`${graph} ids "${file}" | grep -c component`).stdout.trim(), '3');
  assert.equal((JSON.parse(run(`${graph} stats`, JSON.stringify(big())).stdout) as { elements: number }).elements, 10);
  const renamed = run(`${graph} rename api order-api "${file}" | ${graph} set --element order-api name="Order API" technology=Rust | ${graph} ids`);
  assert.match(renamed.stdout, /^order-api\tcontainer\tunchanged\tOrder API$/m);
  const head = join(dir, 'head.json');
  writeFileSync(head, run(`${graph} drop --ids lonely "${file}"`).stdout);
  assert.match(run(`${graph} diff "${file}" "${head}" | ${graph} ids`).stdout, /^lonely\tsystem\tremoved\tLONELY$/m);
  assert.equal((JSON.parse(run(`${graph} merge "${head}" "${file}"`).stdout) as DiagramSpec).elements.length, 10);

  const lintFail = run(`${diagram} --lint-only`, JSON.stringify({ ...big(), relationships: [rel('user', 'page', 'uses')] }));
  assert.equal(lintFail.status, 1);
  assert.equal(lintFail.stdout, '');
  assert.match(lintFail.stderr, /error: .*says nothing/);
  const warned = run(`${diagram} -`, JSON.stringify(big()));
  assert.equal(warned.status, 0);
  assert.match(warned.stderr, /warning: element "user" has no description/);
  assert.match(warned.stdout, /^<svg /);
  assert.match(run(`${diagram} --mermaid --no-lint "${file}"`).stdout, /^flowchart TB/);
  assert.equal(run(`${diagram} "${file}"`).stdout.trim(), join(dir, 'big.svg'));
  assert.equal(run(`${diagram} "${file}" --theme split`).status, 2);
  assert.deepEqual(run(`${diagram} "${file}" --theme split -o "${join(dir, 'x.svg')}"`).stdout.trim().split('\n'), [join(dir, 'x.light.svg'), join(dir, 'x.dark.svg')]);
  assert.equal(run(`${diagram} "${file}" --theme neon`).status, 2);
});

test('split: an overview with groups folded, and a view per changed group', async () => {
  const { split, splitGroups } = await import('../src/graph/split.ts');
  const spec = JSON.parse(readFileSync(new URL('../examples/diagrams/in-process.json', import.meta.url), 'utf8')) as DiagramSpec;
  assert.deepEqual(splitGroups(spec), ['main', 'worker']);
  const views = split(spec);
  assert.ok(views.overview.elements.length < spec.elements.length);
  assert.ok(!views.overview.elements.some((e) => e.parent === 'main' || e.parent === 'worker'));
  assert.equal(views.overview.elements.find((e) => e.id === 'worker')?.status, 'added');
  assert.deepEqual(views.details.map((d) => d.id), ['main', 'worker']);
  const main = views.details[0]!.spec;
  assert.ok(main.elements.some((e) => e.id === 'editor'));
  assert.ok(!main.elements.some((e) => e.id === 'core'));
  for (const v of [views.overview, ...views.details.map((d) => d.spec)]) assert.deepEqual(lintSpec(v).errors, []);
});

test('set: several elements and relationship patterns in one call', () => {
  const spec = JSON.parse(readFileSync(new URL('../examples/diagrams/in-process.json', import.meta.url), 'utf8')) as DiagramSpec;
  const out = set(set(spec, { element: 'renderer,shaper', fields: { status: 'affected', kind: 'package' } }), { relationship: 'editor:*,host:core', fields: { status: 'changed' } });
  assert.deepEqual(out.elements.filter((e) => e.id === 'renderer' || e.id === 'shaper').map((e) => [e.status, e.kind]), [['affected', 'package'], ['affected', 'package']]);
  assert.ok(out.relationships.filter((r) => r.from === 'editor').every((r) => r.status === 'changed'));
  assert.equal(out.relationships.find((r) => r.from === 'host' && r.to === 'core')?.status, 'changed');
  assert.equal(out.relationships.find((r) => r.from === 'core' && r.to === 'shaper')?.status, undefined);
  assert.throws(() => set(spec, { relationship: 'nope:*', fields: { status: 'added' } }), UsageError);
});
