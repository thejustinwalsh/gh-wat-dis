import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { analyze, listElements, reachOf, resolveOwners, toCodeSpec, toDiagramSpec, toMarkdown } from '../src/impact/index.ts';
import { lintSpec } from '../src/diagram/lint.ts';
import type { Facts } from '../src/impact/index.ts';
import { ELEMENT_TYPES, PROVENANCE, STATUSES } from '../src/spec.ts';
import type { DiagramSpec } from '../src/spec.ts';

const NOW = new Date('2026-06-01T12:00:00Z');
const DAY = 86_400_000;
const BIN = resolve(import.meta.dirname, '../src/bin.ts');
const repos: string[] = [];
test.after(() => { for (const r of repos) rmSync(r, { recursive: true, force: true }); });

type Files = Record<string, string | null>;

function repo(): { dir: string; commit: (files: Files, daysAgo: number, msg?: string) => void; write: (files: Files) => void } {
  const dir = mkdtempSync(join(tmpdir(), 'wat-impact-'));
  repos.push(dir);
  const git = (args: string[], date?: string): void => {
    execFileSync('git', args, {
      cwd: dir, stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
    });
  };
  const write = (files: Files): void => {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) { rmSync(join(dir, path)); continue; }
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  };
  git(['init', '-q', '-b', 'main']);
  return {
    dir, write,
    commit(files, daysAgo, msg = 'change') {
      write(files);
      git(['add', '-A']);
      git(['commit', '-q', '-m', msg], new Date(NOW.getTime() - daysAgo * DAY).toISOString());
    },
  };
}

const cli = (args: string[], input?: string): string =>
  execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8', input: input ?? '', stdio: ['pipe', 'pipe', 'pipe'] });

function assertFactsShape(f: Facts): void {
  assert.equal(f.schema, 1);
  const labelled = [...f.files, ...f.symbols, ...f.dependents.direct, ...f.dependents.transitive, ...f.elements, ...f.edges, ...f.contracts, ...f.coChange, ...f.dependencies];
  for (const x of labelled) assert.ok(PROVENANCE.includes(x.provenance), `provenance on ${JSON.stringify(x).slice(0, 80)}`);
  const ids = new Set(f.elements.map((e) => e.id));
  assert.equal(ids.size, f.elements.length, 'element ids are unique');
  for (const e of f.edges) assert.ok(ids.has(e.from) && ids.has(e.to) && e.from !== e.to, `edge ${e.from} -> ${e.to}`);
  for (const x of [...f.files, ...f.symbols, ...f.dependents.direct, ...f.dependents.transitive]) assert.ok(ids.has(x.element), `element ${x.element}`);
}

function assertSpecValid(spec: DiagramSpec): void {
  const ids = new Set(spec.elements.map((e) => e.id));
  assert.equal(ids.size, spec.elements.length, 'unique ids');
  for (const e of spec.elements) {
    assert.ok(ELEMENT_TYPES.includes(e.type), `type ${e.type}`);
    assert.ok(e.status && STATUSES.includes(e.status), `status ${e.status}`);
    assert.ok(e.name && e.description);
    assert.ok(!e.parent || ids.has(e.parent), `parent ${e.parent}`);
    assert.ok(e.meta && 'filesChanged' in e.meta && 'dependentsAffected' in e.meta && 'provenance' in e.meta);
  }
  for (const r of spec.relationships) {
    assert.ok(ids.has(r.from) && ids.has(r.to), `endpoints ${r.from} -> ${r.to}`);
    assert.ok(r.label.trim() && r.label !== 'uses', `label "${r.label}"`);
    assert.ok(r.status && STATUSES.includes(r.status));
    assert.ok(r.meta && typeof r.meta.weight === 'number' && PROVENANCE.includes(r.meta.provenance as never));
  }
}

function assertMarkdownShape(md: string): void {
  const lines = md.trimEnd().split('\n');
  assert.match(lines[0]!, /^## Blast radius$/);
  assert.match(lines[2]!, /^\*\*\d+ files? changed in \d+ elements? · \d+ direct dependents?.*\*\*$/);
  assert.match(lines[lines.length - 1]!, /^_Sources: git[^_]*\.( Labels: [a-z, ]+\.)?_$/);
  lines.forEach((line, i) => {
    if (/^\*\*[A-Z][^*]+\*\*$/.test(line)) assert.match(lines[i + 1] ?? '', /^- /, `section "${line}" is empty`);
  });
  assert.ok(lines.length <= 45, `${lines.length} lines`);
  assert.doesNotMatch(md, /\b(should|consider|risky|dangerous|careful|recommend|missing tests?)\b/i);
}

// ---------------------------------------------------------------- TypeScript monorepo

const PRICE_V1 = `// price helpers
export function formatPrice(amount: number): string {
  return amount.toFixed(2);
}

export function legacyFormat(amount: number): string {
  return String(amount);
}

export const TAX = 0.2;

export class Money {
  constructor(readonly amount: number) {}
  add(other: Money): Money { return new Money(this.amount + other.amount); }
}

export interface PriceOptions { currency: string }
`;
const PRICE_V2 = `// price helpers, v2
export function formatPrice(amount: number, currency: string): string {
  return currency + amount.toFixed(2);
}

export const TAX = 0.2;

export class Money {
  constructor(readonly amount: number) {}
  add(other: Money, round: boolean): Money { return new Money(round ? Math.round(this.amount + other.amount) : this.amount + other.amount); }
}

export interface PriceOptions { currency: string; locale: string }

export function parsePrice(text: string): number { return Number(text); }
`;

function tsMonorepo(): string {
  const r = repo();
  r.commit({
    'package.json': JSON.stringify({ name: 'acme', private: true, workspaces: ['packages/*'] }),
    'tsconfig.json': `{
  // aliases
  "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["packages/shared/src/*"], } },
}`,
    '.github/CODEOWNERS': '* @acme/all\n/packages/shared/ @acme/core @alice\n/packages/web/ @acme/web\n*.proto @acme/api\n',
    'packages/shared/package.json': JSON.stringify({ name: '@acme/shared', main: 'dist/index.js' }),
    'packages/shared/src/price.ts': PRICE_V1,
    'packages/shared/src/price.test.ts': "import { formatPrice } from './price';\nformatPrice(1);\n",
    'packages/shared/src/index.ts': "export * from './price.js';\n",
    'packages/api/package.json': JSON.stringify({ name: '@acme/api', dependencies: { '@acme/shared': 'workspace:*', express: '^4.0.0' } }),
    'packages/api/src/server.ts': "import { formatPrice } from '@acme/shared';\nexport const handle = (): string => formatPrice(1);\n",
    'packages/api/src/routes.ts': "import { handle } from './server.ts';\nexport const routes = [handle];\n",
    'packages/api/schema/api.proto': 'syntax = "proto3";\nmessage Price { int64 amount = 1; }\n',
    'packages/web/package.json': JSON.stringify({ name: '@acme/web', dependencies: { '@acme/shared': 'workspace:*' } }),
    'packages/web/src/cart.ts': "import * as shared from '@acme/shared';\nexport const cart = (): string => shared.formatPrice(2);\n",
    'packages/web/src/total.ts': "import { formatPrice, legacyFormat } from '@lib/price';\nexport const total = (): string => formatPrice(3) + legacyFormat(3);\n",
    'packages/web/src/total.test.ts': "import { formatPrice } from '../../shared/src/price.ts';\nformatPrice(4);\n",
    'packages/web/src/app.ts': "import { total } from './total';\nexport const app = total;\n",
    'packages/web/src/lazy.ts': "export const load = () => import('./app.js');\nconst legacy = require('./cart');\nexport { legacy };\n",
    'docs/pricing.md': '# Pricing\n',
    'tools/report.py': 'print("v1")\n',
  }, 30, 'init');
  for (const [i, days] of [20, 15, 10].entries()) {
    r.commit({ 'packages/shared/src/price.ts': PRICE_V1.replace('// price helpers', `// price helpers ${i}`), 'docs/pricing.md': `# Pricing ${i}\n` }, days, `tune ${i}`);
  }
  r.commit({
    'packages/shared/src/price.ts': PRICE_V2,
    'packages/shared/src/price.test.ts': "import { formatPrice } from './price';\nformatPrice(1, '$');\n",
    'packages/api/schema/api.proto': 'syntax = "proto3";\nmessage Price { int64 amount = 1; string currency = 2; }\n',
    'packages/api/package.json': JSON.stringify({ name: '@acme/api', dependencies: { '@acme/shared': 'workspace:*', express: '^5.0.0', zod: '^3.0.0' } }),
    'tools/report.py': 'print("v2")\n',
  }, 1, 'currency');
  return r.dir;
}

let tsRepo: string | undefined;
let tsFacts: Facts | undefined;
async function tsFixture(): Promise<{ dir: string; facts: Facts }> {
  tsRepo ??= tsMonorepo();
  tsFacts ??= await analyze({ cwd: tsRepo, base: 'HEAD~1', now: NOW });
  return { dir: tsRepo, facts: tsFacts };
}

test('ts: git tier reports files, kinds, churn, owners and dependency changes', async () => {
  const { facts } = await tsFixture();
  assertFactsShape(facts);
  assert.deepEqual(facts.files.map((f) => f.path), [
    'packages/api/package.json', 'packages/api/schema/api.proto', 'packages/shared/src/price.test.ts', 'packages/shared/src/price.ts', 'tools/report.py']);
  const byPath = new Map(facts.files.map((f) => [f.path, f]));
  const price = byPath.get('packages/shared/src/price.ts')!;
  assert.equal(price.status, 'modified');
  assert.equal(price.kind, 'source');
  assert.equal(price.language, 'typescript');
  assert.equal(price.element, 'acme-shared');
  assert.deepEqual(price.owners, ['@acme/core', '@alice']);
  assert.equal(price.churn90d, 5);
  assert.equal(price.provenance, 'exact');
  assert.equal(price.source, 'git');
  assert.ok(price.insertions > 0 && price.deletions > 0);
  assert.equal(byPath.get('packages/api/package.json')!.kind, 'manifest');
  assert.equal(byPath.get('packages/api/schema/api.proto')!.kind, 'schema');
  assert.deepEqual(byPath.get('packages/api/schema/api.proto')!.owners, ['@acme/api']);
  assert.equal(byPath.get('packages/shared/src/price.test.ts')!.kind, 'test');
  assert.deepEqual(byPath.get('tools/report.py')!.owners, ['@acme/all']);
  assert.deepEqual(facts.summary.byKind, { manifest: 1, schema: 1, test: 1, source: 2 });
  assert.equal(facts.summary.filesChanged, 5);
  assert.deepEqual(facts.dependencies.map((d) => [d.name, d.change, d.from, d.to, d.section]), [
    ['express', 'bumped', '^4.0.0', '^5.0.0', 'dependencies'], ['zod', 'added', undefined, '^3.0.0', 'dependencies']]);
  assert.ok(facts.caveats.includes('no symbol analysis for .py'));
  assert.deepEqual(facts.tiers.languages, ['typescript']);
  assert.ok(['git', 'ast-grep', 'codeowners', 'manifest'].every((t) => facts.tiers.ran.includes(t)));
  assert.equal(facts.owners.find((o) => o.owner === '@acme/web')!.dependentFiles.length, 3);
});

test('ts: changed symbols, signatures, added and removed exports', async () => {
  const { facts } = await tsFixture();
  const sym = (name: string) => facts.symbols.find((s) => s.name === name && s.file === 'packages/shared/src/price.ts');
  const fp = sym('formatPrice')!;
  assert.equal(fp.change, 'modified');
  assert.equal(fp.exported, true);
  assert.equal(fp.signatureChanged, true);
  assert.equal(fp.before, 'function formatPrice(amount: number): string');
  assert.equal(fp.after, 'function formatPrice(amount: number, currency: string): string');
  assert.equal(fp.source, 'ast-grep');
  assert.deepEqual(fp.dependents.map((d) => [d.file, d.provenance, d.inDiff]), [
    ['packages/api/src/server.ts', 'resolved', false],
    ['packages/shared/src/index.ts', 'heuristic', false],
    ['packages/shared/src/price.test.ts', 'resolved', true],
    ['packages/web/src/cart.ts', 'heuristic', false],
    ['packages/web/src/total.test.ts', 'resolved', false],
    ['packages/web/src/total.ts', 'resolved', false],
  ]);
  const legacy = sym('legacyFormat')!;
  assert.equal(legacy.change, 'removed');
  assert.ok(legacy.dependents.some((d) => d.file === 'packages/web/src/total.ts' && d.provenance === 'resolved'));
  assert.equal(sym('parsePrice')!.change, 'added');
  assert.equal(sym('TAX'), undefined);
  assert.equal(sym('Money.add')!.signatureChanged, true);
  assert.equal(sym('Money')!.signatureChanged, false);
  assert.equal(sym('PriceOptions')!.signatureChanged, true);
  assert.equal(facts.summary.exportedSignatureChanges, 3);
});

test('ts: dependents, provenance labels, transitive rollup, tests and co-change', async () => {
  const { facts } = await tsFixture();
  const direct = new Map(facts.dependents.direct.map((d) => [d.file, d]));
  assert.deepEqual([...direct.keys()], [
    'packages/api/src/server.ts', 'packages/shared/src/index.ts', 'packages/web/src/cart.ts', 'packages/web/src/total.test.ts', 'packages/web/src/total.ts']);
  assert.equal(direct.get('packages/api/src/server.ts')!.provenance, 'resolved');
  assert.deepEqual(direct.get('packages/api/src/server.ts')!.symbols, ['formatPrice']);
  assert.deepEqual(direct.get('packages/api/src/server.ts')!.via, ['@acme/shared']);
  assert.equal(direct.get('packages/web/src/cart.ts')!.provenance, 'heuristic');
  assert.equal(direct.get('packages/web/src/total.ts')!.provenance, 'resolved');
  assert.deepEqual(direct.get('packages/web/src/total.ts')!.via, ['@lib/price']);
  assert.equal(direct.get('packages/web/src/total.test.ts')!.isTest, true);
  assert.equal(facts.summary.directDependents, 5);
  assert.deepEqual(facts.dependents.transitive, [
    { element: 'acme-web', count: 5, minDepth: 1, provenance: 'measured' },
    { element: 'acme-api', count: 2, minDepth: 1, provenance: 'measured' },
    { element: 'acme-shared', count: 1, minDepth: 1, provenance: 'measured' },
  ]);
  const shallow = await analyze({ cwd: (await tsFixture()).dir, base: 'HEAD~1', now: NOW, depth: 1 });
  assert.equal(shallow.dependents.transitive.find((t) => t.element === 'acme-web')!.count, 3);
  assert.deepEqual(facts.tests, { changed: ['packages/shared/src/price.test.ts'], importingChanged: ['packages/web/src/total.test.ts'] });
  assert.deepEqual(facts.coChange, [{ file: 'docs/pricing.md', withFile: 'packages/shared/src/price.ts', commits: 4, ratio: 0.8, provenance: 'measured' }]);
  assert.deepEqual(facts.contracts.map((c) => [c.path, c.kind]), [['packages/api/schema/api.proto', 'protobuf']]);
});

test('ts: elements, edges, markdown and spec', async () => {
  const { facts } = await tsFixture();
  const el = new Map(facts.elements.map((e) => [e.id, e]));
  assert.equal(el.get('acme-shared')!.status, 'changed');
  assert.equal(el.get('acme-shared')!.provenance, 'heuristic');
  assert.equal(el.get('acme-api')!.status, 'changed');
  assert.equal(el.get('acme-web')!.status, 'affected');
  assert.equal(el.get('acme-web')!.dependentsAffected, 5);
  assert.equal(el.get('docs')!.status, 'unchanged');
  assert.equal(el.get('tools')!.status, 'changed');
  assert.equal(facts.summary.elementsChanged, 3);
  const edge = (from: string, to: string) => facts.edges.find((e) => e.from === from && e.to === to);
  assert.deepEqual(edge('acme-web', 'acme-shared'), { from: 'acme-web', to: 'acme-shared', weight: 3, status: 'unchanged', provenance: 'exact', source: 'manifest' });
  assert.equal(edge('acme-api', 'acme-shared')!.weight, 1);

  const md = toMarkdown(facts);
  assertMarkdownShape(md);
  assert.match(md, /\*\*5 files changed in 3 elements · 5 direct dependents · 3 exported signatures changed\*\*/);
  assert.match(md, /^Changes @acme\/api, @acme\/shared, tools\. Reaches @acme\/web \(5 files\)\.$/m);
  assert.match(md, /^Owners: .*@alice/m);
  assert.doesNotMatch(md, /^\|/m);
  assert.match(md, /\*\*Depends on the changed code, not in this diff\*\*\n- `packages\//);
  assert.match(md, /`function formatPrice\(amount: number\): string` → `function formatPrice\(amount: number, currency: string\): string`.*6 dependents \(1 in this diff\)/);
  assert.match(md, /- `Money\.add`: `add\(other: Money\): Money` → `add\(other: Money, round: boolean\): Money`/);
  assert.match(md, /- removed `legacyFormat` \(`packages\/shared\/src\/price\.ts`\) · 3 dependents\n- added `parsePrice` \(`packages\/shared\/src\/price\.ts`\)\n/);
  assert.match(md, /- `packages\/web\/src\/total\.test\.ts`/);
  assert.match(md, /- `docs\/pricing\.md` with `packages\/shared\/src\/price\.ts` · 4 commits in 90 days \(80%\)/);
  assert.match(md, /- bumped `express` \^4\.0\.0 → \^5\.0\.0/);
  assert.match(md, /_Sources: git, ast-grep \(TypeScript\), codeowners, manifest\. Labels: exact, resolved, measured, heuristic\._/);
  assert.doesNotMatch(md, /Files changed\*\*/);
  const linked = toMarkdown({ ...facts, repository: 'https://github.com/acme/shop' });
  assertMarkdownShape(linked);
  assert.ok(linked.includes(`[\`packages/web/src/total.test.ts\`](https://github.com/acme/shop/blob/${facts.head.slice(0, 12)}/packages/web/src/total.test.ts)`));
  assert.doesNotMatch(toMarkdown({ ...facts, repository: 'https://github.com/acme/shop' }, { links: false }), /\]\(https:/);
  assert.doesNotMatch(toMarkdown({ ...facts, repository: 'https://github.com/acme/shop', head: 'WORKING_TREE' }), /\]\(https:/);
  assert.match(toMarkdown(facts, { maxItems: 1 }), /- \+2 more/);
  assert.doesNotMatch(toMarkdown(facts, { heading: false }), /^## /m);

  const spec = toDiagramSpec(facts);
  assertSpecValid(spec);
  // `tools` is a folder with no package: next to a workspace it is not an element.
  assert.deepEqual(spec.elements.map((e) => e.id).sort(), ['acme-api', 'acme-shared', 'acme-web']);
  // A generated line says what moves, and how many files import across it.
  assert.deepEqual([spec.relationships.find((r) => r.from === 'acme-web')!.label, spec.relationships.find((r) => r.from === 'acme-web')!.technology], ['Imports formatPrice and legacyFormat from', '3 imports'], 'a generated line names what moves across it');
  assert.equal(spec.elements.find((e) => e.id === 'acme-shared')!.description, '4 files · 2 changed');
  const all = toDiagramSpec(facts, { all: true, title: 'Everything' });
  assertSpecValid(all);
  assert.equal(all.title, 'Everything');
  assert.equal(all.elements.length, facts.elements.length);
  assert.equal(all.relationships.length, facts.edges.length);
});

test('ts: file level spec has a card per file with changed symbols and per importer, and lines to symbol rows', async () => {
  const { facts } = await tsFixture();
  const { spec, drawn, changedLeftOut, dependentsLeftOut } = toCodeSpec(facts);
  assert.deepEqual(lintSpec(spec), { errors: [], warnings: [] });
  assert.equal(spec.type, 'code');
  const files = spec.elements.filter((e) => e.type === 'file');
  assert.equal(files.length, drawn);
  const price = files.find((e) => e.id === 'packages/shared/src/price.ts')!;
  assert.equal(price.status, 'changed');
  assert.ok(price.symbols!.length > 0 && price.symbols!.every((s) => s.kind && ['added', 'changed', 'removed'].includes(s.status!)));
  assert.equal(price.symbols!.find((s) => s.name === 'formatPrice')!.status, 'changed');
  // Every changed symbol the card lists is a fact, and the card says when it lists only some.
  for (const s of price.symbols!) assert.ok(facts.symbols.some((f) => f.file === price.id && f.name === s.name), s.name);
  // An importer outside the diff is a card with no rows. It is affected when a symbol it names changed its signature.
  const server = files.find((e) => e.id === 'packages/api/src/server.ts')!;
  assert.deepEqual([server.symbols, server.status], [undefined, 'affected']);
  // One line for each file that imports another. The server imports formatPrice through the package entry, which
  // re-exports it and is a card too: the line goes to the entry, and the entry's re-export is the line on to price.ts.
  const line = (from: string, to: string): number => spec.relationships.filter((r) => r.from === from && r.to === to && r.label === '').length;
  assert.deepEqual([line(server.id, 'packages/shared/src/index.ts'), line('packages/shared/src/index.ts', price.id), line(server.id, price.id)], [1, 1, 0]);
  for (const r of spec.relationships) {
    if (r.toSymbol !== undefined) assert.ok(files.find((e) => e.id === r.to)!.symbols!.some((s) => s.name === r.toSymbol), `${r.to}#${r.toSymbol}`);
  }
  // Groups are the architecture elements, one level deep, and only when there is more than one.
  const groups = spec.elements.filter((e) => e.type === 'boundary');
  assert.ok(groups.length > 1 && groups.every((g) => g.parent === undefined));
  assert.ok(files.every((e) => e.parent === undefined || groups.some((g) => g.id === e.parent)));
  // A changed file that is not source (a page, a proto file) is counted in the scope line, not drawn.
  assert.ok(!files.some((e) => e.id === 'docs/pricing.md'));
  assert.deepEqual(changedLeftOut, []);
  assert.match(spec.scope!, /\d of \d changed source files drawn\. .*other changed files? \(pages, config, assets\)/);
  assert.equal(dependentsLeftOut.length + files.filter((e) => !e.status || e.status === 'affected').length, new Set(facts.dependents.direct.map((d) => d.file)).size);

  // Past the budget the file with the most change stays, and what is cut is named.
  const two = toCodeSpec(facts, { maxFiles: 2, title: 'Two' });
  assert.equal(two.spec.title, 'Two');
  assert.equal(two.drawn, 2);
  assert.ok(two.spec.elements.some((e) => e.id === price.id));
  assert.ok(two.dependentsLeftOut.length > 0);
  assert.match(two.spec.scope!, /more importers? not drawn/);
  assert.deepEqual(lintSpec(two.spec).errors, []);
});

test('ts: working tree picks up staged, unstaged and untracked files', async () => {
  const r = repo();
  r.commit({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': "import { a } from './a';\nexport const b = a;\n", 'src/c.ts': 'export const c = 1;\n' }, 5);
  r.write({ 'src/a.ts': 'export const a = 2;\nexport const extra = 1;\n', 'src/new.ts': "import { c } from './c';\nexport const n = c;\n" });
  execFileSync('git', ['add', 'src/a.ts'], { cwd: r.dir });
  r.write({ 'src/c.ts': 'export const c = 2;\n' });
  const facts = await analyze({ cwd: r.dir, workingTree: true, now: NOW });
  assertFactsShape(facts);
  assert.equal(facts.head, 'WORKING_TREE');
  assert.deepEqual(facts.files.map((f) => [f.path, f.status]), [['src/a.ts', 'modified'], ['src/c.ts', 'modified'], ['src/new.ts', 'added']]);
  assert.deepEqual(facts.dependents.direct.map((d) => d.file), ['src/b.ts']);
  assert.ok(facts.symbols.some((s) => s.name === 'extra' && s.change === 'added'));
  const committed = await analyze({ cwd: r.dir, now: NOW });
  assert.equal(committed.files.length, 0);
  assert.ok(committed.caveats.some((c) => c.includes('same commit')));
  assertMarkdownShape(toMarkdown(committed));
});

test('webUrl: ssh and https remotes give the same web address', async () => {
  const { webUrl } = await import('../src/impact/git.ts');
  for (const r of ['git@github.com:o/r.git', 'https://github.com/o/r.git', 'https://github.com/o/r', 'ssh://git@github.com/o/r.git', 'https://token@github.com/o/r.git\n']) {
    assert.equal(webUrl(r), 'https://github.com/o/r');
  }
  assert.equal(webUrl(null), null);
  assert.equal(webUrl('/srv/git/r.git'), null);
});

test('reach: path, path#symbol and bare symbol', async () => {
  const { dir } = await tsFixture();
  const res = await reachOf({ cwd: dir, targets: ['packages/shared/src/price.ts', 'packages/shared/src/price.ts#formatPrice', 'formatPrice', 'TAX', 'nope'] });
  const [path, hashed, bare, tax, nope] = res.targets;
  assert.deepEqual(path!.matches[0]!.direct.map((d) => d.file), [
    'packages/api/src/server.ts', 'packages/shared/src/index.ts', 'packages/shared/src/price.test.ts',
    'packages/web/src/cart.ts', 'packages/web/src/total.test.ts', 'packages/web/src/total.ts']);
  assert.equal(hashed!.matches[0]!.symbol, 'formatPrice');
  assert.equal(hashed!.matches[0]!.kind, 'function');
  assert.equal(hashed!.matches[0]!.direct.find((d) => d.file === 'packages/web/src/cart.ts')!.provenance, 'heuristic');
  assert.equal(hashed!.matches[0]!.direct.find((d) => d.file === 'packages/api/src/server.ts')!.provenance, 'resolved');
  assert.deepEqual(hashed!.matches[0]!.transitive.find((t) => t.element === 'acme-api'), { element: 'acme-api', count: 2, minDepth: 1, provenance: 'measured' });
  assert.equal(bare!.ambiguous, false);
  assert.equal(bare!.matches[0]!.file, 'packages/shared/src/price.ts');
  assert.deepEqual(bare!.matches[0]!.direct, hashed!.matches[0]!.direct);
  assert.deepEqual(tax!.matches[0]!.direct.map((d) => [d.file, d.provenance]), [['packages/shared/src/index.ts', 'heuristic'], ['packages/web/src/cart.ts', 'heuristic']]);
  assert.equal(nope!.found, false);

  const r = repo();
  r.commit({ 'a/x.ts': 'export const same = 1;\n', 'b/x.ts': 'export const same = 2;\n', 'c.ts': "import { same } from './a/x';\nexport default same;\n" }, 3);
  const amb = (await reachOf({ cwd: r.dir, targets: ['same'] })).targets[0]!;
  assert.equal(amb.ambiguous, true);
  assert.deepEqual(amb.matches.map((m) => [m.file, m.direct.length]), [['a/x.ts', 1], ['b/x.ts', 0]]);
});

test('owners: last match wins; elements: workspace fallback', async () => {
  const { dir } = await tsFixture();
  const owners = await resolveOwners({ cwd: dir, paths: ['packages/web/src/app.ts', 'packages/shared/schema/x.proto', 'README.md'] });
  assert.deepEqual(owners.map((o) => [o.owners, o.rule]), [[['@acme/web'], '/packages/web/'], [['@acme/api'], '*.proto'], [['@acme/all'], '*']]);
  assert.ok(owners.every((o) => o.file === '.github/CODEOWNERS' && o.provenance === 'exact'));
  const els = await listElements({ cwd: dir });
  assert.equal(els.mapping, 'workspace');
  const shared = els.elements.find((e) => e.id === 'acme-shared')!;
  assert.deepEqual([shared.found, shared.files, shared.globs, shared.provenance], ['workspace', 4, ['packages/shared/**'], 'heuristic']);
  assert.ok(els.unmapped.includes('docs/pricing.md') && els.unmapped.includes('tsconfig.json'));
  assert.equal(els.elements.find((e) => e.id === 'docs')!.found, 'directory');
});

test('cli: impact | blast, graph from-facts, owners from stdin, reach, elements, usage errors', async () => {
  const { dir } = await tsFixture();
  const out = cli(['impact', '--base', 'HEAD~1', '--cwd', dir]);
  const facts = JSON.parse(out) as Facts;
  assert.equal(facts.summary.filesChanged, 5);
  assert.match(out, /^\{\n  "schema": 1,/);
  assertMarkdownShape(cli(['blast', '--max-items', '3'], out));
  assertSpecValid(JSON.parse(cli(['graph', 'from-facts', '-', '--title', 'T'], out)) as DiagramSpec);
  const owners = JSON.parse(cli(['owners', '-', '--cwd', dir], 'packages/web/src/app.ts\n\ntools/report.py\n')) as { path: string; owners: string[] }[];
  assert.deepEqual(owners.map((o) => [o.path, o.owners]), [['packages/web/src/app.ts', ['@acme/web']], ['tools/report.py', ['@acme/all']]]);
  assert.equal((JSON.parse(cli(['reach', 'formatPrice', '--cwd', dir, '--depth', '1'])) as { targets: unknown[] }).targets.length, 1);
  assert.equal((JSON.parse(cli(['elements', '--cwd', dir])) as { mapping: string }).mapping, 'workspace');
  for (const cmd of ['impact', 'blast', 'reach', 'owners', 'elements']) assert.match(cli([cmd, '--help']), /^Usage: gh-wat-dis /);
  assert.match(cli(['graph', 'from-facts', '--help']), /^Usage: gh-wat-dis graph from-facts/);
  const code = JSON.parse(cli(['graph', 'from-facts', '-', '--level', 'file', '--max-files', '3'], out)) as DiagramSpec;
  assert.deepEqual([code.type, code.elements.filter((e) => e.type === 'file').length], ['code', 3]);
  const fails = (args: string[], input = ''): number => {
    try { cli(args, input); return 0; } catch (e) { return (e as { status: number }).status; }
  };
  assert.equal(fails(['impact', '--nope']), 2);
  assert.equal(fails(['graph', 'from-facts', '-', '--level', 'line'], out), 2);
  assert.equal(fails(['graph', 'from-facts', '-', '--max-files', '3'], out), 2);
  assert.equal(fails(['graph', 'from-facts', '-', '--level', 'file', '--all'], out), 2);
  assert.equal(fails(['blast'], '{"not":"facts"}'), 2);
  assert.equal(fails(['reach', '--cwd', dir]), 2);
  assert.equal(fails(['reach', 'doesNotExist', '--cwd', dir]), 1);
  assert.equal(fails(['impact', '--base', 'no-such-ref', '--cwd', dir]), 1);
});

// ---------------------------------------------------------------- Rust workspace

function rustWorkspace(): string {
  const r = repo();
  const pricing = (sig: string, body: string): string => `/// Formats a price.
pub fn format_price(${sig}) -> String {
    ${body}
}

pub(crate) fn helper() -> u64 { 1 }

pub const RATE: u64 = 2;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats() { let _ = helper(); }
}
`;
  const shape = (extra: string): string => `pub trait Describe {
    fn describe(&self) -> String;
}

pub struct Circle {
    pub r: f64,
}

impl Circle {
    pub fn area(&self) -> f64 { self.r * self.r * 3.14 }
    fn secret(&self) {}
}
${extra}`;
  r.commit({
    'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\nresolver = "2"\n\n[workspace.dependencies]\nserde = "1"\n',
    'CODEOWNERS': '/crates/core/ @rust/core\n/crates/api/ @rust/api\n',
    'crates/core/Cargo.toml': '[package]\nname = "core-crate"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nserde = { workspace = true }\n',
    'crates/core/src/lib.rs': 'pub mod pricing;\npub mod shape;\n\npub use pricing::format_price;\n',
    'crates/core/src/pricing.rs': pricing('amount: u64', 'amount.to_string()'),
    'crates/core/src/shape.rs': shape(''),
    'crates/api/Cargo.toml': '[package]\nname = "api"\nversion = "0.1.0"\n\n[dependencies]\ncore-crate = { path = "../core" }\n',
    'crates/api/src/lib.rs': 'mod everything;\n\nuse core_crate::pricing::format_price;\nuse core_crate::shape::{Circle, Describe as D};\n\npub fn quote() -> String { format_price(1) }\n',
    'crates/api/src/everything.rs': 'use core_crate::pricing::*;\n\npub fn rate() -> u64 { RATE }\n',
    'crates/api/tests/quote.rs': 'use core_crate::format_price;\n\n#[test]\nfn quotes() { format_price(1); }\n',
    'crates/cli/Cargo.toml': '[package]\nname = "cli"\nversion = "0.1.0"\n\n[dependencies]\napi = { path = "../api" }\n\n[dev-dependencies]\nserde = "1"\n',
    'crates/cli/src/main.rs': 'use api::quote;\n\nfn main() { println!("{}", quote()); }\n',
  }, 12, 'init');
  r.commit({
    'crates/core/src/pricing.rs': pricing('amount: u64, currency: &str', 'format!("{currency}{amount}")'),
    'crates/core/src/shape.rs': shape('\nimpl Describe for Circle {\n    fn describe(&self) -> String { String::from("circle") }\n}\n'),
    'crates/cli/Cargo.toml': '[package]\nname = "cli"\nversion = "0.1.0"\n\n[dependencies]\napi = { path = "../api" }\ncore-crate = { path = "../core" }\n\n[dev-dependencies]\nserde = "1.0.200"\n',
  }, 2, 'currency');
  return r.dir;
}

test('rust: signatures, trait impls, dependents through use paths, crate edges', async () => {
  const dir = rustWorkspace();
  const facts = await analyze({ cwd: dir, base: 'HEAD~1', now: NOW });
  assertFactsShape(facts);
  assert.deepEqual(facts.tiers.languages, ['rust']);
  assert.deepEqual(facts.tiers.unavailable, []);

  const sym = (name: string) => facts.symbols.find((s) => s.name === name);
  const fp = sym('format_price')!;
  assert.equal(fp.file, 'crates/core/src/pricing.rs');
  assert.equal(fp.kind, 'function');
  assert.equal(fp.change, 'modified');
  assert.equal(fp.signatureChanged, true);
  assert.equal(fp.before, 'pub fn format_price(amount: u64) -> String');
  assert.equal(fp.after, 'pub fn format_price(amount: u64, currency: &str) -> String');
  assert.deepEqual(fp.dependents.map((d) => [d.file, d.provenance]), [
    ['crates/api/src/everything.rs', 'heuristic'],
    ['crates/api/src/lib.rs', 'resolved'],
    ['crates/api/tests/quote.rs', 'resolved'],
    ['crates/core/src/lib.rs', 'resolved'],
  ]);
  const impl = sym('impl Describe for Circle')!;
  assert.deepEqual([impl.kind, impl.change, impl.exported], ['trait-impl', 'added', true]);
  assert.ok(impl.dependents.some((d) => d.file === 'crates/api/src/lib.rs' && d.provenance === 'heuristic'));
  assert.equal(sym('helper'), undefined);
  assert.equal(sym('Circle'), undefined);
  assert.equal(facts.summary.exportedSignatureChanges, 1);

  const direct = new Map(facts.dependents.direct.map((d) => [d.file, d]));
  assert.deepEqual([...direct.keys()], ['crates/api/src/everything.rs', 'crates/api/src/lib.rs', 'crates/api/tests/quote.rs', 'crates/core/src/lib.rs']);
  assert.equal(direct.get('crates/api/src/everything.rs')!.provenance, 'heuristic');
  assert.deepEqual(direct.get('crates/api/src/everything.rs')!.via, ['core_crate::pricing::*']);
  assert.equal(direct.get('crates/api/src/lib.rs')!.provenance, 'resolved');
  assert.deepEqual(direct.get('crates/api/src/lib.rs')!.symbols, ['format_price']);
  assert.equal(direct.get('crates/api/tests/quote.rs')!.isTest, true);
  assert.deepEqual(facts.tests.importingChanged, ['crates/api/tests/quote.rs']);
  assert.deepEqual(facts.dependents.transitive, [
    { element: 'api', count: 3, minDepth: 1, provenance: 'measured' },
    { element: 'core-crate', count: 1, minDepth: 1, provenance: 'measured' },
    { element: 'cli', count: 1, minDepth: 2, provenance: 'measured' },
  ]);

  const el = new Map(facts.elements.map((e) => [e.id, e]));
  assert.deepEqual(['core-crate', 'api', 'cli'].map((id) => el.get(id)!.status), ['changed', 'affected', 'changed']);
  assert.equal(el.get('core-crate')!.technology, 'Rust crate');
  const edge = (from: string, to: string) => facts.edges.find((e) => e.from === from && e.to === to);
  assert.deepEqual(edge('api', 'core-crate'), { from: 'api', to: 'core-crate', weight: 4, status: 'unchanged', provenance: 'exact', source: 'manifest' });
  assert.deepEqual(edge('cli', 'api'), { from: 'cli', to: 'api', weight: 1, status: 'unchanged', provenance: 'exact', source: 'manifest' });
  assert.deepEqual(edge('cli', 'core-crate'), { from: 'cli', to: 'core-crate', weight: 0, status: 'added', provenance: 'exact', source: 'manifest' });
  assert.deepEqual(facts.dependencies.map((d) => [d.name, d.section, d.change, d.from, d.to]), [
    ['core-crate', 'dependencies', 'added', undefined, 'path:../core'], ['serde', 'dev-dependencies', 'bumped', '1', '1.0.200']]);
  assert.deepEqual(facts.files.find((f) => f.path === 'crates/core/src/pricing.rs')!.owners, ['@rust/core']);
  assert.ok(facts.files.find((f) => f.path === 'crates/core/src/pricing.rs')!.hunkFunctions.length <= 2);

  const md = toMarkdown(facts);
  assertMarkdownShape(md);
  assert.match(md, /`pub fn format_price\(amount: u64\) -> String` → `pub fn format_price\(amount: u64, currency: &str\) -> String`/);
  assert.match(md, /- added `impl Describe for Circle`/);
  assert.match(md, /ast-grep \(Rust\)/);
  const spec = toDiagramSpec(facts);
  assertSpecValid(spec);
  assert.equal(spec.relationships.find((r) => r.from === 'cli' && r.to === 'core-crate')!.label, 'Declares a dependency on');

  const reach = await reachOf({ cwd: dir, targets: ['format_price', 'crates/core/src/shape.rs#Circle::area'] });
  assert.deepEqual(reach.targets[0]!.matches.map((m) => m.file), ['crates/core/src/pricing.rs']);
  assert.equal(reach.targets[0]!.matches[0]!.direct.length, 4);
  assert.deepEqual(reach.targets[0]!.matches[0]!.transitive.find((t) => t.element === 'cli'), { element: 'cli', count: 1, minDepth: 2, provenance: 'measured' });
  assert.deepEqual(reach.targets[1]!.matches[0]!.direct.map((d) => [d.file, d.provenance]), [['crates/api/src/lib.rs', 'heuristic']]);
});

// ---------------------------------------------------------------- Config architecture map

test('config: architecture map drives elements, edges and labels', async () => {
  const r = repo();
  const files: Files = {
    'src/server/handler.ts': 'export function handle(id: string): string { return id; }\n',
    'src/server/db/schema.sql': 'create table t (id int);\n',
    'src/client/view.ts': "import { handle } from '../server/handler.ts';\nexport const view = handle('1');\n",
    'src/client/page.tsx': "import { view } from './view';\nexport const Page = () => <p>{view}</p>;\n",
    'lib/misc.ts': "import { view } from '../src/client/view';\nexport const misc = view;\n",
    'README.md': '# demo\n',
  };
  r.commit(files, 9, 'init');
  const before = await listElements({ cwd: r.dir });
  assert.equal(before.mapping, 'directory');
  assert.deepEqual(before.elements.map((e) => e.name).sort(), ['(root)', 'lib', 'src']);
  assert.ok(before.elements.every((e) => e.provenance === 'heuristic' && e.found === 'directory'));
  assert.deepEqual(before.unmapped, []);

  r.commit({
    '.agents/gh-wat-dis/config.json': JSON.stringify({
      version: 1,
      architecture: {
        system: { name: 'Demo', description: '' },
        elements: [
          { id: 'platform', name: 'Platform', type: 'boundary' },
          { id: 'db', name: 'Database', type: 'datastore', technology: 'Postgres', parent: 'platform', paths: ['src/server/db/**'] },
          { id: 'server', name: 'API server', type: 'container', technology: 'Node', description: 'Serves requests', parent: 'platform', paths: ['src/server/**'] },
          { id: 'client', name: 'Web client', type: 'container', paths: ['src/client/*.{ts,tsx}'] },
          { id: 'mail', name: 'Mail', type: 'system', external: true },
        ],
        relationships: [{ from: 'client', to: 'server', label: 'calls API', technology: 'HTTPS' }, { from: 'server', to: 'mail', label: 'sends mail' }],
      },
    }),
  }, 8, 'map');
  r.commit({
    'src/server/handler.ts': 'export function handle(id: string, verbose: boolean): string { return verbose ? id : ""; }\n',
    'src/server/db/schema.sql': 'create table t (id int, name text);\n',
  }, 1, 'verbose');

  const listed = await listElements({ cwd: r.dir });
  assert.equal(listed.mapping, 'config');
  const byId = new Map(listed.elements.map((e) => [e.id, e]));
  assert.deepEqual([byId.get('server')!.files, byId.get('server')!.globs, byId.get('server')!.found], [1, ['src/server/**'], 'config']);
  assert.deepEqual([byId.get('db')!.files, byId.get('client')!.files, byId.get('platform')!.files], [1, 2, 0]);
  assert.deepEqual(listed.unmapped.sort(), ['.agents/gh-wat-dis/config.json', 'README.md', 'lib/misc.ts']);
  assert.equal(byId.get('lib')!.found, 'directory');

  const facts = await analyze({ cwd: r.dir, base: 'HEAD~1', now: NOW });
  assertFactsShape(facts);
  assert.ok(facts.tiers.ran.includes('config'));
  const el = new Map(facts.elements.map((e) => [e.id, e]));
  assert.deepEqual([el.get('server')!.status, el.get('server')!.provenance, el.get('server')!.source, el.get('server')!.type], ['changed', 'exact', 'config', 'container']);
  assert.deepEqual([el.get('db')!.status, el.get('db')!.type, el.get('db')!.parent], ['changed', 'datastore', 'platform']);
  assert.deepEqual([el.get('client')!.status, el.get('client')!.dependentsAffected], ['affected', 2]);
  assert.deepEqual([el.get('lib')!.status, el.get('lib')!.provenance], ['affected', 'heuristic']);
  assert.equal(el.get('mail')!.external, true);
  assert.deepEqual(facts.edges.find((e) => e.from === 'client' && e.to === 'server'),
    { from: 'client', to: 'server', weight: 1, status: 'unchanged', label: 'calls API', technology: 'HTTPS', provenance: 'exact', source: 'config' });
  assert.deepEqual(facts.edges.find((e) => e.from === 'lib'), { from: 'lib', to: 'client', weight: 1, status: 'unchanged', provenance: 'resolved', source: 'ast-grep' });
  assert.deepEqual(facts.contracts.map((c) => [c.path, c.kind]), [['src/server/db/schema.sql', 'sql']]);
  assert.equal(facts.symbols.find((s) => s.name === 'handle')!.signatureChanged, true);

  const spec = toDiagramSpec(facts);
  assertSpecValid(spec);
  // `mail` is an unchanged neighbour the change does not reach, so only --all draws it. `lib` is a folder the map does not name.
  assert.deepEqual(spec.elements.map((e) => e.id).sort(), ['client', 'db', 'platform', 'server']);
  assert.ok(toDiagramSpec(facts, { all: true }).elements.some((e) => e.id === 'mail'));
  const rel = spec.relationships.find((x) => x.from === 'client' && x.to === 'server')!;
  assert.deepEqual([rel.label, rel.technology, rel.meta], ['calls API', 'HTTPS', { weight: 1, provenance: 'exact', source: 'config' }]);
  assert.equal(spec.elements.find((e) => e.id === 'server')!.description, 'Serves requests');
  assert.equal(spec.elements.find((e) => e.id === 'db')!.description, '1 file · 1 changed');
  assertSpecValid(toDiagramSpec(facts, { all: true }));
  assertMarkdownShape(toMarkdown(facts));

  // An import added in this diff shows up as an added edge; a removed one as a removed edge.
  r.commit({ 'src/server/handler.ts': "import { misc } from '../../lib/misc';\nexport function handle(id: string, verbose: boolean): string { return verbose ? id : misc; }\n", 'src/client/view.ts': "export const view = '1';\n" }, 0.5, 'rewire');
  const rewired = await analyze({ cwd: r.dir, base: 'HEAD~1', now: NOW });
  assertFactsShape(rewired);
  assert.equal(rewired.edges.find((e) => e.from === 'server' && e.to === 'lib')!.status, 'added');
  const gone = rewired.edges.find((e) => e.from === 'client' && e.to === 'server')!;
  assert.deepEqual([gone.status, gone.weight, gone.label], ['removed', 0, 'calls API']);
  assertSpecValid(toDiagramSpec(rewired));
});

test('complexity: callbacks count toward the named function around them, and pairs follow the name', async () => {
  const { TOP_LEVEL, pair, units } = await import('../src/impact/complexity.ts');
  const fn = (name: string, line: number, cognitive: number, children: unknown[] = []) => ({ name, kind: 'function', line, cognitive, cyclomatic: cognitive + 1, children });
  const u = units([
    fn('load', 3, 2, [fn('<anonymous>', 4, 3), fn('retry', 6, 1, [fn('<anonymous>', 7, 4)])]),
    fn('<anonymous>', 20, 5),
  ] as never);
  assert.deepEqual(u.map((x) => [x.name, x.cognitive, x.cyclomatic]), [['load', 5, 6], ['load > retry', 5, 6], [TOP_LEVEL, 5, 6]]);

  const at = (name: string, line: number, cognitive: number) => ({ name, kind: 'function', line, cognitive, cyclomatic: 1 });
  const pairs = pair([at('a', 1, 1), at('dup', 10, 2), at('dup', 50, 3), at('gone', 70, 4)], [at('dup', 52, 9), at('a', 5, 1), at('new', 80, 2)]);
  const show = pairs.map((p) => `${p.base?.name ?? '-'}@${p.base?.line ?? ''}>${p.head?.name ?? '-'}@${p.head?.line ?? ''}`).sort();
  assert.deepEqual(show, ['-@>new@80', 'a@1>a@5', 'dup@10>-@', 'dup@50>dup@52', 'gone@70>-@']);
});

test('complexity: facts are absent unless a cccc binary is named, and a missing one is reported', async () => {
  const r = repo();
  r.commit({ 'src/a.ts': 'export function a(x: number) { return x; }\n' }, 5);
  r.commit({ 'src/a.ts': 'export function a(x: number) { if (x > 1) { for (const y of [x]) { if (y) return y; } } return x; }\n' }, 1);
  const plain = await analyze({ cwd: r.dir, base: 'HEAD~1', now: NOW });
  assert.deepEqual(plain.complexity, []);
  assert.equal(plain.summary.complexity, undefined);
  const missing = await analyze({ cwd: r.dir, base: 'HEAD~1', now: NOW, cccc: null });
  assert.ok(missing.tiers.unavailable.some((t) => t.tool === 'cccc' && /doctor --tools install/.test(t.reason)));
  const broken = await analyze({ cwd: r.dir, base: 'HEAD~1', now: NOW, cccc: join(r.dir, 'no-such-binary') });
  assert.deepEqual(broken.complexity, []);
  assert.ok(broken.tiers.unavailable.some((t) => t.tool === 'cccc'));
  assert.ok(!broken.tiers.ran.includes('cccc'));

  const { locate } = await import('../src/tools/cccc.ts');
  const found = locate();
  if (!found) return; // cccc is optional: the measured half runs only where it is installed
  const facts = await analyze({ cwd: r.dir, base: 'HEAD~1', now: NOW, cccc: found.path });
  assert.ok(facts.tiers.ran.includes('cccc'));
  assert.equal(facts.complexity.length, 1);
  assert.deepEqual([facts.complexity[0]!.name, facts.complexity[0]!.change, facts.complexity[0]!.before], ['a', 'modified', { cognitive: 0, cyclomatic: 1 }]);
  assert.ok(facts.complexity[0]!.after!.cognitive >= 5);
  assert.equal(facts.summary.complexity!.functions, 1);
});

test('cccc: the pinned manifest names an asset and a sha256 for each platform', async () => {
  const { CCCC } = await import('../src/tools/cccc.ts');
  assert.deepEqual(Object.keys(CCCC.assets).sort(), ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']);
  for (const a of Object.values(CCCC.assets)) {
    assert.ok(a.file.startsWith(`cccc-v${CCCC.version}-`), a.file);
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
  }
});

test('symbols: a comment is not a change, one name of a re-export list is one change, private declarations that come or go are listed', async () => {
  const { parseTs } = await import('../src/impact/ts-parse.ts');
  const { diffSymbols, code } = await import('../src/impact/symbols.ts');
  const diff = (before: string, after: string) => diffSymbols(parseTs('a.ts', before, true).syms, parseTs('a.ts', after, true).syms);
  // Only the doc comment and the layout of the type differ.
  assert.deepEqual(diff(
    "/** Reads src/old/path. */\nexport interface Backend { play(id: string): void; // see old/path\n}\n",
    "/** Reads src/new/path. */\nexport interface Backend {\n  play(id: string): void; // see new/path\n}\n"), []);
  // A string that holds two slashes is code, not a comment.
  assert.equal(diff("export const url = 'http://a';\n", "export const url = 'http://b';\n")[0]!.change, 'modified');
  assert.equal(code("const a = 1; // one\n/* two */ const b = `//x`;"), 'const a = 1;\nconst b = `//x`;');
  // Four names join a list of seventeen: four are added and none of the others is touched.
  const names = Array.from({ length: 17 }, (_, i) => `T${i}`);
  const list = (extra: string[]): string => `export type { ${[...names, ...extra].join(', ')} } from './protocol.js';\n`;
  assert.deepEqual(diff(list([]), list(['N1', 'N2', 'N3', 'N4'])).map((c) => [c.name, c.change]), [['N1', 'added'], ['N2', 'added'], ['N3', 'added'], ['N4', 'added']]);
  // A helper that moves out of a file and one that arrives are part of the change, exported or not.
  const moved = diff('function handlePlay() { return 1; }\nfunction keep() { return 2; }\n', 'function keep() { return 2; }\nfunction enqueue() {\n  return 3;\n}\n');
  assert.deepEqual(moved.map((c) => [c.name, c.change, c.exported]), [['handlePlay', 'removed', false], ['enqueue', 'added', false]]);
  assert.ok(moved.every((c) => c.lines > 0));
  // A signature whose comment changed is not a changed signature.
  const sig = diff('export function f(a: number /* old */): number { return a; }\n', 'export function f(a: number /* new */): number { return a + 1; }\n');
  assert.deepEqual([sig[0]!.change, sig[0]!.signatureChanged, sig[0]!.lines], ['modified', false, 2]);
});

/** Facts with only the parts a code diagram reads. */
function codeFacts(part: Partial<Facts>): Facts {
  return {
    schema: 1, base: 'a'.repeat(40), head: 'b'.repeat(40), range: { baseRef: 'a', headRef: 'b', workingTree: false, depth: 3 },
    tiers: { ran: ['git', 'ast-grep'], languages: ['typescript'], unavailable: [] },
    summary: { filesChanged: 0, insertions: 0, deletions: 0, byKind: {}, elementsChanged: 0, directDependents: 0, exportedSignatureChanges: 0 },
    files: [], symbols: [], dependents: { direct: [], transitive: [] }, imports: [], elements: [], edges: [], contracts: [],
    tests: { changed: [], importingChanged: [] }, coChange: [], dependencies: [], complexity: [], owners: [], caveats: [], ...part,
  };
}
const fileFact = (path: string, lines: number, more: Partial<Facts['files'][number]> = {}): Facts['files'][number] => ({
  path, status: 'modified', insertions: lines, deletions: 0, kind: 'source', language: 'typescript', element: 'app', owners: [], churn90d: 0, hunkFunctions: [], provenance: 'exact', source: 'git', ...more,
});
const symbolFact = (file: string, name: string, more: Partial<Facts['symbols'][number]> = {}): Facts['symbols'][number] => ({
  name, kind: 'function', file, element: 'app', exported: true, change: 'modified', signatureChanged: false, lines: 4, dependents: [], provenance: 'resolved', source: 'ast-grep', ...more,
});

test('code spec: only a named import ends on a symbol row, and a guessed one ends on the file', () => {
  const facts = codeFacts({
    files: [fileFact('src/sprite.ts', 40), fileFact('src/llm.ts', 30)],
    symbols: [
      symbolFact('src/sprite.ts', 'Sprite.addEffect', { kind: 'method', dependents: [
        // These import the class, and nothing shows that they call the method.
        { file: 'src/app.tsx', element: 'app', inDiff: false, provenance: 'heuristic' },
        { file: 'src/game.tsx', element: 'app', inDiff: false, provenance: 'heuristic' },
      ] }),
      symbolFact('src/llm.ts', 'chat', { signatureChanged: true, dependents: [
        { file: 'src/list.ts', element: 'app', inDiff: false, provenance: 'heuristic' },
        { file: 'src/panel.ts', element: 'app', inDiff: false, provenance: 'resolved' },
      ] }),
    ],
  });
  const { spec } = toCodeSpec(facts);
  assert.deepEqual(lintSpec(spec).errors, []);
  const line = (from: string, to: string) => spec.relationships.filter((r) => r.from === from && r.to === to).map((r) => r.toSymbol ?? 'the file');
  assert.deepEqual(line('src/app.tsx', 'src/sprite.ts'), ['the file']);
  assert.deepEqual(line('src/game.tsx', 'src/sprite.ts'), ['the file']);
  // `import * as llm` reaches the file. The file that names `chat` reaches its row.
  assert.deepEqual(line('src/list.ts', 'src/llm.ts'), ['the file']);
  assert.deepEqual(line('src/panel.ts', 'src/llm.ts'), ['chat']);
  // Affected means a proven use of a signature that changed. A guess does not earn the mark.
  const status = (id: string) => spec.elements.find((e) => e.id === id)!.status;
  assert.deepEqual([status('src/panel.ts'), status('src/list.ts')], ['affected', undefined]);
});

test('code spec: a new import of an unchanged file is drawn, with the added mark, on a row for the name', () => {
  const facts = codeFacts({
    files: [fileFact('src/signon.ts', 12), fileFact('scripts/gen.ts', 37, { status: 'added' }), fileFact('src/main.ts', 5)],
    symbols: [symbolFact('src/signon.ts', 'signOn'), symbolFact('scripts/gen.ts', 'withAll', { change: 'added' }), symbolFact('src/main.ts', 'helpText')],
    imports: [
      { from: 'src/signon.ts', to: 'src/llm.ts', toElement: 'app', toInDiff: false, names: ['probeWebGPU'], whole: false, change: 'added', provenance: 'resolved' },
      { from: 'scripts/gen.ts', to: 'src/main.ts', toElement: 'app', toInDiff: true, names: ['TOOLS'], whole: false, change: 'added', provenance: 'resolved' },
      { from: 'src/signon.ts', to: 'src/old.ts', toElement: 'app', toInDiff: false, names: ['legacy'], whole: false, change: 'removed', provenance: 'resolved' },
    ],
  });
  const { spec } = toCodeSpec(facts);
  assert.deepEqual(lintSpec(spec), { errors: [], warnings: [] }, 'the spec passes the lint of the tool that wrote it');
  const llm = spec.elements.find((e) => e.id === 'src/llm.ts')!;
  assert.deepEqual([llm.status, llm.symbols], [undefined, [{ name: 'probeWebGPU' }]]);
  assert.deepEqual(spec.relationships.find((r) => r.from === 'src/signon.ts' && r.to === 'src/llm.ts'), { from: 'src/signon.ts', to: 'src/llm.ts', label: '', toSymbol: 'probeWebGPU', status: 'added' });
  // The generator imports TOOLS, which did not change: main.ts gains a row for it. The import is not on base, so it is green, new file or not.
  const main = spec.elements.find((e) => e.id === 'src/main.ts')!;
  assert.deepEqual(main.symbols!.map((s) => [s.name, s.status]), [['helpText', 'changed'], ['TOOLS', undefined]]);
  assert.deepEqual(spec.relationships.find((r) => r.from === 'scripts/gen.ts'), { from: 'scripts/gen.ts', to: 'src/main.ts', label: '', toSymbol: 'TOOLS', status: 'added' });
  // A file the change stopped importing gets no card of its own.
  assert.ok(!spec.elements.some((e) => e.id === 'src/old.ts'));
  // An import that did not change is a line too, between two changed files as from a file outside the diff.
  // It ends on the file when it names nothing that has a row.
  const kept = toCodeSpec(codeFacts({
    files: [fileFact('src/doctor.ts', 30), fileFact('src/install.ts', 10), fileFact('src/gone.ts', 20, { status: 'deleted' })],
    symbols: [symbolFact('src/doctor.ts', 'run'), symbolFact('src/install.ts', 'install'), symbolFact('src/gone.ts', 'old', { change: 'removed' })],
    imports: [
      { from: 'src/doctor.ts', to: 'src/install.ts', toElement: 'app', toInDiff: true, names: ['skillNames'], whole: false, change: 'unchanged', provenance: 'resolved' },
      { from: 'src/install.ts', to: 'src/doctor.ts', toElement: 'app', toInDiff: true, names: [], whole: true, change: 'unchanged', provenance: 'resolved' },
      { from: 'src/doctor.ts', to: 'src/gone.ts', toElement: 'app', toInDiff: true, names: ['old'], whole: false, change: 'removed', provenance: 'resolved' },
    ],
    dependents: { direct: [
      // Outside the diff: one names a changed symbol, one names only symbols that did not change.
      { file: 'src/a.ts', element: 'app', imports: ['src/doctor.ts'], via: ['./doctor.ts'], symbols: ['run'], isTest: false, provenance: 'resolved' },
      { file: 'src/b.ts', element: 'app', imports: ['src/doctor.ts'], via: ['./doctor.ts'], symbols: [], isTest: false, provenance: 'resolved' },
    ], transitive: [] },
  })).spec;
  const lines = kept.relationships.map((r) => `${r.from} -> ${r.to}${r.toSymbol ? `#${r.toSymbol}` : ''}${r.status ? ` (${r.status})` : ''}`).sort();
  assert.deepEqual(lines, ['src/a.ts -> src/doctor.ts#run', 'src/doctor.ts -> src/gone.ts#old (removed)', 'src/doctor.ts -> src/install.ts', 'src/install.ts -> src/doctor.ts']);
  // The file that imports nothing that changed gets no card.
  assert.ok(!kept.elements.some((e) => e.id === 'src/b.ts'));
});

test('code spec: slots go to the most changed files, a file that was not read says so, a move is named, and nothing to draw is an error', async () => {
  const names = Array.from({ length: 21 }, (_, i) => `T${i}`);
  const facts = codeFacts({
    files: [
      fileFact('src/generation.ts', 1012, { status: 'added' }), fileFact('src/collapse.ts', 880, { status: 'added' }), fileFact('src/register.ts', 182),
      fileFact('src/index.ts', 4), fileFact('src/constants.ts', 9), fileFact('test/golden.ts', 300, { kind: 'test' }), fileFact('tools/shoot.mjs', 355, { status: 'added', language: 'javascript' }),
      fileFact('native/backend.rs', 22, { language: 'rust', skipped: 'larger than 500 KB' }),
      fileFact('src/moved/a.ts', 3, { status: 'renamed', oldPath: 'src/old/a.ts' }), fileFact('src/moved/b.ts', 0, { status: 'renamed', oldPath: 'src/old/b.ts' }),
      fileFact('docs/index.html', 70, { kind: 'docs', language: null }), fileFact('src/zig/run.zig', 215, { language: null }),
    ],
    symbols: [
      symbolFact('src/generation.ts', 'small', { change: 'added', lines: 3 }), symbolFact('src/generation.ts', 'generateChunk', { change: 'added', exported: false, lines: 240 }),
      symbolFact('src/collapse.ts', 'tick', { change: 'added', lines: 90 }), symbolFact('src/register.ts', 'register', { lines: 60 }),
      ...names.map((n) => symbolFact('src/index.ts', n, { kind: 'reexport', lines: 1 })),
      symbolFact('src/constants.ts', 'A'), symbolFact('test/golden.ts', 'golden'), symbolFact('src/moved/a.ts', 'a'),
    ],
    tests: { changed: ['test/golden.ts'], importingChanged: [] },
  });
  const all = toCodeSpec(facts);
  const card = (id: string) => all.spec.elements.find((e) => e.id === id);
  // A new script with no named declaration still gets a card. The page does not.
  assert.equal(card('tools/shoot.mjs')!.description, '+355 lines');
  assert.equal(card('docs/index.html'), undefined);
  assert.equal(card('native/backend.rs')!.description, 'not read: larger than 500 KB · +22');
  assert.deepEqual(all.notRead[0], { path: 'native/backend.rs', reason: 'larger than 500 KB' });
  assert.equal(card('src/moved/a.ts')!.description, 'moved from src/old/a.ts');
  // A file that only moved has no card, and the scope line counts the moves.
  assert.equal(card('src/moved/b.ts'), undefined);
  // Source in a language the tools do not read is named as that, not as a page.
  assert.match(all.spec.scope!, /Not drawn: golden\.ts \(\+300\)\. 2 files moved\. 1 changed source file in a language the tools do not read \(\.zig\)\. 1 other changed file \(pages, config, assets\)$/);
  assert.ok(all.notRead.some((f) => f.path === 'src/zig/run.zig'));
  // Rows: the hardest work first, private or not: the most complexity gained, then the most lines changed.
  assert.deepEqual(card('src/generation.ts')!.symbols!.map((s) => s.name), ['generateChunk', 'small']);
  assert.equal(card('src/zig/run.zig'), undefined);
  // The list of re-exports shows six of its names and says how many more.
  // A test never takes a card before source does: eight slots, and the test is the ninth file.
  assert.equal(card('test/golden.ts'), undefined, 'the test is the ninth file');
  assert.ok(card('src/index.ts'));
  assert.equal(toCodeSpec(facts, { maxFiles: 9 }).spec.elements.find((e) => e.id === 'src/index.ts')!.description, 'and 15 more symbols');

  const three = toCodeSpec(facts, { maxFiles: 3 });
  assert.deepEqual(three.spec.elements.map((e) => e.id), ['src/generation.ts', 'src/collapse.ts', 'tools/shoot.mjs']);
  // A fixture and a list of re-exports rank below real files with less change.
  assert.ok(three.changedLeftOut.indexOf('src/register.ts') < three.changedLeftOut.indexOf('test/golden.ts'));
  assert.ok(three.changedLeftOut.indexOf('src/constants.ts') < three.changedLeftOut.indexOf('src/index.ts'));
  assert.match(three.spec.scope!, /3 of 9 changed source files drawn\. Not drawn: register\.ts \(\+182\), backend\.rs \(\+22\) and 4 more/);

  // No source file at all: there is no code diagram, and the command says so with exit 1.
  const none = toCodeSpec(codeFacts({ files: [fileFact('docs/index.html', 70, { kind: 'docs', language: null })] }));
  assert.equal(none.drawn, 0);
  const { spawnSync } = await import('node:child_process');
  const run = spawnSync(process.execPath, [new URL('../src/bin.ts', import.meta.url).pathname, 'graph', 'from-facts', '-', '--level', 'file'],
    { input: JSON.stringify(codeFacts({ files: [fileFact('docs/index.html', 70, { kind: 'docs', language: null })] })), encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /touches no source file in a language the tools parse/);
  assert.match(lintSpec(none.spec).errors.join('\n'), /elements is empty/);
});

test('facts: a changed architecture map, new imports of a changed file, and a file over the parse cap', async () => {
  const r = repo();
  const config = (extra: object[], rels: object[], serverNote = 'Serves requests'): string => JSON.stringify({
    version: 1,
    architecture: {
      system: { name: 'Demo', description: '' },
      elements: [
        { id: 'server', name: 'API server', type: 'container', technology: 'Node', description: serverNote, paths: ['src/server/**'] },
        { id: 'client', name: 'Web client', type: 'container', technology: 'TS', paths: ['src/client/**'] },
        ...extra,
      ],
      relationships: [{ from: 'client', to: 'server', label: 'Calls', technology: 'HTTPS' }, ...rels],
    },
  });
  const big = `export function huge(): number { return 1; }\n${'// padding to pass the parse cap\n'.repeat(17000)}`;
  r.commit({
    '.agents/gh-wat-dis/config.json': config([], []),
    'src/server/handler.ts': 'export function handle(id: string): string { return id; }\nexport const limit = 3;\n',
    'src/server/big.ts': big,
    'src/client/view.ts': "import { handle } from '../server/handler.ts';\nexport const view = handle('1');\n",
  }, 3, 'init');
  r.commit({
    '.agents/gh-wat-dis/config.json': config(
      [{ id: 'cache', name: 'Cache', type: 'datastore', technology: 'Redis', external: true }],
      [{ from: 'server', to: 'cache', label: 'Reads sessions from', technology: 'RESP' }], 'Serves requests and sessions'),
    'src/client/view.ts': "import { handle, limit } from '../server/handler.ts';\nexport const view = handle('1') + limit;\n",
    'src/server/big.ts': big.replace('return 1', 'return 2'),
  }, 1, 'cache');
  const facts = await analyze({ cwd: r.dir, base: 'HEAD~1', now: NOW });
  assertFactsShape(facts);
  // The map itself changed: a new element is added, an edited one is changed, a new relationship is added.
  const status = new Map(facts.elements.map((e) => [e.id, e.status]));
  assert.deepEqual([status.get('cache'), status.get('server'), status.get('client')], ['added', 'changed', 'changed']);
  assert.equal(facts.edges.find((e) => e.from === 'server' && e.to === 'cache')!.status, 'added');
  assert.equal(facts.edges.find((e) => e.from === 'client' && e.to === 'server')!.status, 'unchanged');
  const spec = toDiagramSpec(facts);
  assert.ok(spec.elements.some((e) => e.id === 'cache' && e.status === 'added'));
  // The stand-in for unmapped files, here the folder that holds the config, is not an element of the picture.
  assert.ok(spec.elements.every((e) => ['cache', 'server', 'client'].includes(e.id)), spec.elements.map((e) => e.id).join(','));
  // The view starts to import `limit`, which did not change.
  const imp = (change: string, names: string[]) => ({ from: 'src/client/view.ts', to: 'src/server/handler.ts', toElement: 'server', toInDiff: false, names, whole: false, change, provenance: 'resolved' });
  assert.deepEqual(facts.imports, [imp('added', ['limit']), imp('unchanged', ['handle'])]);
  // The big file was not parsed, and the facts say so in three places.
  const bigFact = facts.files.find((f) => f.path === 'src/server/big.ts')!;
  assert.equal(bigFact.skipped, 'larger than 500 KB');
  assert.match(facts.tiers.unavailable.map((u) => u.reason).join('\n'), /1 changed source file\(s\) larger than 500 KB were not parsed: src\/server\/big\.ts/);
  assert.match(facts.caveats.join('\n'), /larger than 500 KB were not parsed/);
  const code = toCodeSpec(facts);
  assert.equal(code.spec.elements.find((e) => e.id === 'src/server/big.ts')!.description, 'not read: larger than 500 KB · +1 −1');
  // The view imported the handler before and still does, now with one more name: one grey line, to the file, since it names two.
  assert.deepEqual(code.spec.relationships.filter((x) => x.from === 'src/client/view.ts' && x.to === 'src/server/handler.ts'), [{ from: 'src/client/view.ts', to: 'src/server/handler.ts', label: '' }]);
});

test('facts: a moved file keeps its imports, and an import of a deleted file is one the change removed', async () => {
  const r = repo();
  const body = (n: number): string => Array.from({ length: 12 }, (_, i) => `export const v${n}_${i} = ${i};`).join('\n') + '\n';
  r.commit({
    'src/tools/zzfx/index.ts': `import { play } from './player.ts';\nimport { helper } from '../shared.ts';\n${body(1)}export const run = () => play() + helper;\n`,
    'src/tools/zzfx/player.ts': `${body(2)}export function play(): number { return 1; }\n`,
    'src/tools/shared.ts': 'export const helper = 1;\n',
    'src/doctor.ts': "import { check } from './sandbox.ts';\nexport const doctor = () => check();\n",
    'src/sandbox.ts': 'export function check(): number { return 1; }\n',
  }, 3, 'init');
  r.commit({
    'src/tools/zzfx/index.ts': null, 'src/tools/zzfx/player.ts': null,
    // The folder is renamed. The only edit is one more export in index.ts.
    'src/tools/audio/index.ts': `import { play } from './player.ts';\nimport { helper } from '../shared.ts';\n${body(1)}export const run = () => play() + helper;\nexport const extra = 1;\n`,
    'src/tools/audio/player.ts': `${body(2)}export function play(): number { return 1; }\n`,
    'src/sandbox.ts': null,
    'src/doctor.ts': 'export const doctor = () => 1;\n',
  }, 1, 'move');
  const facts = await analyze({ cwd: r.dir, base: 'HEAD~1', now: NOW });
  assert.deepEqual(facts.files.filter((f) => f.status === 'renamed').map((f) => [f.oldPath, f.path]), [
    ['src/tools/zzfx/index.ts', 'src/tools/audio/index.ts'], ['src/tools/zzfx/player.ts', 'src/tools/audio/player.ts']]);
  // No import of the moved file is new: it imported the same two files from its old place.
  const moved = facts.imports.filter((i) => i.from === 'src/tools/audio/index.ts');
  assert.deepEqual(moved.map((i) => [i.to, i.change, i.names]), [['src/tools/audio/player.ts', 'unchanged', ['play']], ['src/tools/shared.ts', 'unchanged', ['helper']]]);
  // The doctor stopped importing a file that is gone.
  assert.deepEqual(facts.imports.filter((i) => i.from === 'src/doctor.ts').map((i) => [i.to, i.change, i.names]), [['src/sandbox.ts', 'removed', ['check']]]);
  const { spec } = toCodeSpec(facts);
  assert.ok(!spec.relationships.some((x) => x.status === 'added'), 'a move adds no import');
  assert.ok(spec.relationships.some((x) => x.from === 'src/doctor.ts' && x.to === 'src/sandbox.ts' && x.status === 'removed'), JSON.stringify(spec.relationships));
});

test('element spec: the end of an added relationship stays though the map does not name it, and a change that reaches everything is cut to what it reaches most', () => {
  const el = (id: string, status: Facts['elements'][number]['status'], more: Partial<Facts['elements'][number]> = {}): Facts['elements'][number] => ({
    id, name: id, type: 'container', status, files: 3, filesChanged: status === 'changed' ? 1 : 0, dependentsAffected: 0, provenance: 'exact', source: 'config', ...more,
  });
  const edge = (from: string, to: string, status: Facts['edges'][number]['status']): Facts['edges'][number] => ({ from, to, weight: 2, status, provenance: 'resolved', source: 'ast-grep' });
  const facts = codeFacts({
    elements: [el('site', 'changed'), el('cli', 'changed'), el('test', 'changed', { source: 'git', provenance: 'heuristic' }), el('root', 'changed', { source: 'git', provenance: 'heuristic' })],
    edges: [edge('test', 'site', 'added'), edge('site', 'cli', 'unchanged'), edge('root', 'cli', 'unchanged')],
  });
  const spec = toDiagramSpec(facts);
  // `test` is a folder, but the change added its relationship to the site, so both ends are drawn. `root` is not.
  assert.deepEqual(spec.elements.map((e) => e.id).sort(), ['cli', 'site', 'test']);
  const added = spec.relationships.find((r) => r.from === 'test')!;
  assert.deepEqual([added.status, added.label, added.technology], ['added', 'Imports code from', '2 imports']);
  // A core package changed and thirty others import it.
  const many = codeFacts({
    elements: [el('core', 'changed'), ...Array.from({ length: 30 }, (_, i) => el(`p${String(i).padStart(2, '0')}`, 'affected', { dependentsAffected: 30 - i }))],
    edges: Array.from({ length: 30 }, (_, i) => edge(`p${String(i).padStart(2, '0')}`, 'core', 'unchanged')),
  });
  const capped = toDiagramSpec(many);
  assert.equal(capped.elements.length, 12);
  assert.ok(capped.elements.some((e) => e.id === 'core') && capped.elements.some((e) => e.id === 'p00') && !capped.elements.some((e) => e.id === 'p29'));
  assert.equal(capped.scope, 'the change and the elements it reaches most; 19 more affected elements are not drawn');
  assert.equal(toDiagramSpec(many, { all: true }).elements.length, 31);
  // With no map, a folder that holds changed source is an element: the change is never "no changed elements".
  const bare = codeFacts({ elements: [el('native', 'added', { source: 'git', provenance: 'heuristic', type: 'component' })], files: [fileFact('native/a.rs', 10, { element: 'native', language: 'rust' })] });
  assert.deepEqual(toDiagramSpec(bare).elements.map((e) => e.id), ['native']);
});

test('budget: both generators stay inside the budget of their diagram type, and the scope line says what was left out', async () => {
  const { BUDGET, load, over } = await import('../src/diagram/budget.ts');
  // Element level: ten changed elements with a line between every pair that is next to or one apart, and one added line.
  const ids = Array.from({ length: 10 }, (_, i) => `e${i}`);
  const element = (id: string): Facts['elements'][number] => ({ id, name: id.toUpperCase(), type: 'container', status: 'changed', files: 3, filesChanged: 1, dependentsAffected: 0, provenance: 'exact', source: 'config' });
  const edge = (from: string, to: string, weight: number, status: Facts['edges'][number]['status'] = 'unchanged'): Facts['edges'][number] => ({ from, to, weight, status, provenance: 'resolved', source: 'ast-grep' });
  const edges = [edge('e9', 'e0', 1, 'added'), ...ids.flatMap((id, i) => [1, 2].filter((d) => i + d < 10).map((d) => edge(id, `e${i + d}`, 10 * d + i)))];
  assert.equal(edges.length, 18);
  const spec = toDiagramSpec(codeFacts({ elements: ids.map(element), edges }));
  // The generator keeps to the counts. How many stand side by side is for lint to say.
  assert.deepEqual(over(spec).filter((w) => !w.includes('side by side')), []);
  assert.equal(load(spec).lines, BUDGET.container.lines);
  assert.ok(spec.relationships.some((r) => r.status === 'added'), 'a relationship the change added is never the one cut');
  // The lightest unchanged lines are the ones left out, and the scope line counts them.
  assert.ok(!spec.relationships.some((r) => r.from === 'e0' && r.to === 'e1') && !spec.relationships.some((r) => r.from === 'e1' && r.to === 'e2'));
  assert.match(spec.scope!, /6 unchanged relationships are not drawn$/);
  assert.equal(toDiagramSpec(codeFacts({ elements: ids.map(element), edges }), { all: true }).relationships.length, 18);

  // File level: four files that each import four changed names from each of the others: one line for each pair is 12,
  // more than the 8 a code diagram holds. The last file goes, and the scope line names it.
  const files = ['a', 'b', 'c', 'd'].map((n) => `src/${n}.ts`);
  const names = (file: string): string[] => [1, 2, 3, 4].map((k) => `${file.slice(4, 5)}${k}`);
  const facts = codeFacts({
    files: files.map((f) => fileFact(f, 20)),
    symbols: files.flatMap((f) => names(f).map((n) => symbolFact(f, n))),
    imports: files.flatMap((from) => files.filter((to) => to !== from).map((to) => ({ from, to, toElement: 'app', toInDiff: true, names: names(to), whole: false, change: 'unchanged' as const, provenance: 'resolved' as const }))),
  });
  const code = toCodeSpec(facts).spec;
  assert.deepEqual(over(code), []);
  assert.equal(code.relationships.length, 6);
  // Every pair of drawn files that imports has a line: no line between two cards means no import.
  const drawnFiles = code.elements.map((e) => e.id);
  for (const from of drawnFiles) for (const to of drawnFiles) if (from !== to) assert.ok(code.relationships.some((r) => r.from === from && r.to === to), `${from} -> ${to}`);
  assert.match(code.scope!, /3 of 4 changed source files drawn\. Left out to keep three layers of files and 8 lines that fit one image: d\.ts$/);
  assert.equal(code.direction, undefined, 'the generator leaves the direction to the form of the type');
  // Each import that names one name with a row ends on that row.
  const one = toCodeSpec(codeFacts({ files: facts.files.slice(0, 2), symbols: facts.symbols.filter((s) => s.file === files[0] || s.file === files[1]),
    imports: [{ from: files[0]!, to: files[1]!, toElement: 'app', toInDiff: true, names: ['b2'], whole: false, change: 'added', provenance: 'resolved' }] })).spec;
  assert.deepEqual(one.relationships, [{ from: files[0], to: files[1], label: '', toSymbol: 'b2', status: 'added' }]);
});

test('budget: a code diagram from facts keeps three layers round the file with the most change, and names what it left out', async () => {
  const { codeShape } = await import('../src/diagram/code-shape.ts');
  // Five changed files that import one another in a chain, the middle one with the most change.
  const paths = ['a', 'b', 'c', 'd', 'e'].map((n) => `src/${n}.ts`);
  const facts = codeFacts({
    files: paths.map((p, i) => fileFact(p, i === 2 ? 90 : 20 - i)),
    symbols: paths.map((p) => symbolFact(p, `fn_${p.slice(4, 5)}`)),
    imports: paths.slice(0, -1).map((from, i) => ({ from, to: paths[i + 1]!, toElement: 'app', toInDiff: true, names: [`fn_${paths[i + 1]!.slice(4, 5)}`], whole: false, change: 'unchanged' as const, provenance: 'resolved' as const })),
  });
  const { spec, changedLeftOut } = toCodeSpec(facts);
  const shape = codeShape(spec);
  assert.deepEqual([shape.depth, shape.beyond], [3, []]);
  assert.equal(spec.elements[0]!.id, 'src/c.ts', 'the file with the most change is listed first');
  assert.deepEqual(spec.elements.map((e) => e.id).sort(), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.deepEqual(changedLeftOut.sort(), ['src/d.ts', 'src/e.ts']);
  assert.match(spec.scope!, /Left out to keep three layers of files and 8 lines that fit one image: (d\.ts, e\.ts|e\.ts, d\.ts)$/);
  assert.deepEqual(lintSpec(spec), { errors: [], warnings: [] }, 'the spec passes the lint of the tool that wrote it');
});

test('code spec: a test never takes a card before source, the first file stays inside three layers, and each file is named once', async () => {
  const { codeShape } = await import('../src/diagram/code-shape.ts');
  const imp = (from: string, to: string, names: string[]) => ({ from, to, toElement: 'app', toInDiff: true, names, whole: false, change: 'unchanged' as const, provenance: 'resolved' as const });
  // Nine changed source files, a changed test that imports the one with the most change, and two files outside the diff that import another.
  const src = Array.from({ length: 9 }, (_, i) => `src/m${i}.ts`);
  const facts = codeFacts({
    files: [fileFact('test/all.test.ts', 400, { kind: 'test' }), ...src.map((f, i) => fileFact(f, 300 - i))],
    symbols: src.map((f) => symbolFact(f, `x${f.slice(5, 6)}`)),
    imports: [imp('test/all.test.ts', 'src/m0.ts', ['x0']), imp('src/u1.ts', 'src/m1.ts', ['x1']), imp('src/u2.ts', 'src/m1.ts', ['x1'])].map((i) => ({ ...i, toInDiff: true })),
  });
  const ids = toCodeSpec(facts).spec.elements.map((e) => e.id);
  assert.ok(!ids.includes('test/all.test.ts'), `the test took a card while source was left out: ${ids.join(', ')}`);

  // A chain of five changed files, the most changed in the middle: three layers are kept with it inside them.
  const chain = Array.from({ length: 5 }, (_, i) => `src/c${i}.ts`);
  const deep = codeFacts({
    files: chain.map((f, i) => fileFact(f, i === 3 ? 500 : 100 - i)),
    symbols: chain.map((f) => symbolFact(f, `y${f.slice(5, 6)}`)),
    imports: chain.slice(0, -1).map((from, i) => imp(from, chain[i + 1]!, [`y${i + 1}`])),
  });
  const { spec } = toCodeSpec(deep);
  assert.ok(spec.elements.some((e) => e.id === 'src/c3.ts'), 'the file with the most change is drawn');
  assert.ok(!codeShape(spec).beyond.length && codeShape(spec).depth <= 3, 'the spec is inside three layers');
  assert.deepEqual(lintSpec(spec), { errors: [], warnings: [] }, 'the spec passes the lint of the tool that wrote it');
  const named = spec.scope!.match(/c\d\.ts/g) ?? [];
  assert.equal(named.length, new Set(named).size, `each file is named once in the scope line: ${spec.scope}`);
});
