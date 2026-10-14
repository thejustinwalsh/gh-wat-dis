import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { lintSpec } from '../src/diagram/lint.ts';
import { decideDiagram } from '../src/impact/decide.ts';
import { analyze, toDiagramSpec, toMarkdown } from '../src/impact/index.ts';
import type { Facts } from '../src/impact/index.ts';
import { diffParts, fileParts, manifestParts, reordered, sourceParts, workflowParts } from '../src/impact/parts.ts';
import { lintBody } from '../src/lint/body.ts';

const NOW = new Date('2026-06-01T12:00:00Z');
const BIN = resolve(import.meta.dirname, '../src/bin.ts');
const dirs: string[] = [];
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function repo(): { dir: string; commit: (files: Record<string, string | null>) => void } {
  const dir = mkdtempSync(join(tmpdir(), 'wat-decide-'));
  dirs.push(dir);
  const git = (args: string[]): void => {
    execFileSync('git', args, {
      cwd: dir, stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
  };
  git(['init', '-q', '-b', 'main']);
  return {
    dir,
    commit(files) {
      for (const [path, text] of Object.entries(files)) {
        if (text === null) { rmSync(join(dir, path)); continue; }
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
      }
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'change']);
    },
  };
}

// ---------------------------------------------------------------- parts

test('parts: a registry of commands, its loaders, the options a usage line lists, and calls that register commands and routes', () => {
  const main = `import { audit } from './gh/audit.ts';
const gh = () => import('./gh/cli.ts');
const COMMANDS = {
  related: async () => (await gh()).related,
  doctor: async () => (await import('./cli/doctor.ts')).main,
  audit,
};
export const TOOLS = [
  { name: 'related', usage: 'related --title <t> [--md]' },
  { name: 'graph from-facts', usage: 'graph from-facts [--level file]' },
];
const helpers = { not: 'a registry' };
`;
  const parts = sourceParts('src/main.ts', main);
  const by = (n: string) => parts.filter((p) => p.name === n);
  assert.deepEqual(by('related').map((p) => [p.kind, p.target]), [['command', './gh/cli.ts'], ['tool', undefined]]);
  assert.equal(by('doctor')[0]!.target, './cli/doctor.ts');
  assert.equal(by('audit')[0]!.target, './gh/audit.ts');
  assert.deepEqual(parts.filter((p) => p.kind === 'option').map((p) => p.name), ['related --title', 'related --md', 'graph from-facts --level']);
  assert.ok(parts.every((p) => p.provenance === 'heuristic' && p.basis.includes('src/main.ts')));
  assert.ok(!parts.some((p) => p.name === 'not'));

  const app = `program.command('serve <dir>').option('-p, --port <n>');
vscode.commands.registerCommand('fl.explain', explain);
app.get('/health', ok);
router.post('/orders', create);
cron.schedule('0 3 * * *', nightly);
map.get('key');
`;
  assert.deepEqual(sourceParts('src/app.js', app).map((p) => `${p.kind} ${p.name}`).sort(),
    ['command fl.explain', 'command serve', 'job 0 3 * * *', 'option --port', 'route GET /health', 'route POST /orders']);
});

test('parts: Rust routes, attribute routes, clap subcommands and long flags', () => {
  const rs = `use axum::Router;
#[derive(Parser)]
struct Cli {
    #[arg(long)]
    dry_run: bool,
    #[arg(long = "out-dir")]
    out: String,
    #[arg(short)]
    v: bool,
}
#[derive(Subcommand)]
enum Command {
    Build,
    #[command(name = "fmt-all")]
    FormatAll,
}
#[get("/users")]
async fn users() {}
fn app() -> Router { Router::new().route("/orders", get(list)) }
`;
  assert.deepEqual(sourceParts('src/main.rs', rs).map((p) => `${p.kind} ${p.name}`).sort(),
    ['command build', 'command fmt-all', 'option --dry-run', 'option --out-dir', 'route /orders', 'route GET /users']);
});

test('parts: manifests, workflows and files that are parts by themselves', () => {
  assert.deepEqual(manifestParts('package.json', JSON.stringify({ name: '@acme/tool', bin: 'dist/bin.js', exports: { '.': './a.js', './lint': './l.js' } }))
    .map((p) => `${p.kind} ${p.name} ${p.provenance}`), ['bin tool exact', 'export . exact', 'export ./lint exact']);
  assert.deepEqual(manifestParts('package.json', JSON.stringify({ name: 'ext', contributes: { commands: [{ command: 'fl.atlas.merge', title: 'Merge' }] } })).map((p) => `${p.kind} ${p.name}`), ['command fl.atlas.merge']);
  assert.deepEqual(manifestParts('Cargo.toml', '[package]\nname = "x"\n\n[[bin]]\nname = "x-cli"\npath = "src/cli.rs"\n').map((p) => [p.name, p.target]), [['x-cli', 'src/cli.rs']]);
  assert.deepEqual(workflowParts('.github/workflows/sweep.yml', "on:\n  schedule:\n    - cron: '0 6 * * 1'\n").map((p) => p.name), ['sweep.yml at 0 6 * * 1']);
  assert.deepEqual(fileParts('skills/wat-audit/SKILL.md').map((p) => `${p.kind} ${p.name} ${p.provenance}`), ['skill wat-audit exact']);
  assert.deepEqual(fileParts('apps/web/app/(shop)/orders/[id]/route.ts').map((p) => p.name), ['/orders/[id]']);
  assert.deepEqual(fileParts('src/bin/migrate.rs').map((p) => p.name), ['migrate']);
  assert.deepEqual(fileParts('src/lib.rs'), []);
});

test('parts: a part listed twice counts once with its handler, and the options of a new command come with it', () => {
  const d = (kind: 'command' | 'tool' | 'option', name: string, target?: string) => ({ kind, name, line: 1, basis: 'b', provenance: 'heuristic' as const, source: 'ast-grep' as const, ...(target ? { target } : {}) });
  const { added, removed } = diffParts(
    [d('command', 'lint', './lint.ts'), d('tool', 'lint'), d('option', 'lint --json'), d('option', 'doctor --fix')],
    [d('command', 'lint', './lint.ts'), d('tool', 'lint'), d('option', 'lint --json'), d('option', 'lint --facts'), d('tool', 'audit'), d('command', 'audit', './audit.ts'), d('option', 'audit --text')],
  );
  // An option takes the handler of its command.
  assert.deepEqual(added.map((x) => [x.name, x.target]), [['lint --facts', './lint.ts'], ['audit', './audit.ts']]);
  assert.deepEqual(removed.map((x) => x.name), ['doctor --fix']);
});

test('steps: the same calls in another order are a reordered flow; a new call is not', () => {
  assert.equal(reordered('run', 'function run() { load(); check(); save(); }', 'function run() { check(); load(); save(); }'), true);
  assert.equal(reordered('run', 'function run() { load(); save(); }', 'function run() { load(); check(); save(); }'), false);
  assert.equal(reordered('run', 'function run() { load(); }', 'function run() { load(); }'), false);
});

// ---------------------------------------------------------------- facts from a repository

const MAP = JSON.stringify({
  version: 1,
  architecture: {
    system: { name: 'Tool', description: '' },
    elements: [
      { id: 'agent', type: 'system', name: 'Agent', external: true, paths: [] },
      { id: 'skills', type: 'container', name: 'Skills', technology: 'Markdown', paths: ['skills/**'] },
      { id: 'cli', type: 'container', name: 'CLI', technology: 'TS', paths: ['src/main.ts'] },
      { id: 'gh', type: 'component', parent: 'cli', name: 'GitHub tools', technology: 'TS', paths: ['src/gh/**'] },
    ],
    relationships: [
      { from: 'agent', to: 'cli', label: 'Runs tools through', technology: 'npx' },
      { from: 'agent', to: 'skills', label: 'Loads instructions from' },
    ],
  },
});
const mainTs = (extra: string) => `const gh = () => import('./gh/cli.ts');
const COMMANDS = {
  related: async () => (await gh()).related,${extra}
};
export const TOOLS = [{ name: 'related', usage: 'related [--md]' }];
export const run = (c: string) => COMMANDS[c as keyof typeof COMMANDS];
`;

test('facts: a command added to a registry is a part of the element its handler is in, and a new skill is a part of the skills', async () => {
  const r = repo();
  r.commit({
    '.agents/gh-wat-dis/config.json': MAP,
    'src/main.ts': mainTs(''),
    'src/gh/cli.ts': 'export const related = (): number => 1;\n',
    'skills/wat/SKILL.md': '# wat\n',
  });
  r.commit({
    'src/main.ts': mainTs("\n  audit: async () => (await gh()).audit,").replace("'related [--md]' }]", "'related [--md] [--json]' }, { name: 'audit', usage: 'audit [--text]' }]"),
    'src/gh/cli.ts': 'export const related = (): number => 1;\nexport const audit = (): number => 2;\n',
    'skills/wat-audit/SKILL.md': '# wat-audit\n',
  });
  const facts = await analyze({ cwd: r.dir, base: 'HEAD~1', now: NOW });
  assert.deepEqual(facts.parts.map((p) => [p.kind, p.name, p.change, p.element, p.provenance, p.calledBy?.element]), [
    ['command', 'audit', 'added', 'gh', 'resolved', 'agent'],
    ['option', 'related --json', 'added', 'gh', 'resolved', 'agent'],
    ['skill', 'wat-audit', 'added', 'skills', 'exact', 'agent'],
  ]);
  assert.match(facts.parts[0]!.basis, /COMMANDS in src\/main\.ts, handler in src\/gh\/cli\.ts/);
  // The audit command's own option comes with it, and is not a part of its own.
  assert.ok(!facts.parts.some((p) => p.name === 'audit --text'));

  assert.equal(facts.diagram.draw, true);
  assert.equal(facts.diagram.level, 'element');
  assert.deepEqual(facts.diagram.reasons.slice(0, 2), ['adds the audit command in GitHub tools', 'adds the wat-audit skill in Skills']);
  assert.ok(facts.diagram.reasons.includes('adds the --json option of related in GitHub tools'));

  // The element spec draws each part inside the element that holds it, with a line from what calls it.
  const spec = toDiagramSpec(facts);
  assert.deepEqual(lintSpec(spec).errors, []);
  const audit = spec.elements.find((e) => e.id === 'part-command-audit')!;
  assert.deepEqual([audit.type, audit.parent, audit.status, audit.technology], ['component', 'gh', 'added', 'Command']);
  const skill = spec.elements.find((e) => e.id === 'part-skill-wat-audit')!;
  assert.deepEqual([skill.parent, skill.status], ['skills', 'added']);
  assert.ok(spec.relationships.some((x) => x.from === 'agent' && x.to === 'part-command-audit' && x.status === 'added' && x.label === 'Runs audit'));
  assert.ok(spec.relationships.some((x) => x.from === 'agent' && x.to === 'part-skill-wat-audit' && x.label === 'Loads wat-audit'));
  // An option is not a box.
  assert.ok(!spec.elements.some((e) => e.name.includes('--')));

  // blast puts the decision first, as a comment.
  assert.match(toMarkdown(facts).split('\n')[0]!, /^<!-- diagram: draw an element diagram: adds the audit command in GitHub tools; .*Draw it: npx gh-wat-dis graph from-facts facts\.json \| npx gh-wat-dis diagram - -o \.wat-tmp\/change\.svg -->$/);
});

test('facts: a command removed from a registry is a removed part, and a removed SKILL.md a removed skill', async () => {
  const r = repo();
  r.commit({
    '.agents/gh-wat-dis/config.json': MAP,
    'src/main.ts': mainTs("\n  audit: async () => (await gh()).audit,"),
    'src/gh/cli.ts': 'export const related = (): number => 1;\nexport const audit = (): number => 2;\n',
    'skills/wat-audit/SKILL.md': '# wat-audit\n',
    'skills/wat/SKILL.md': '# wat\n',
  });
  r.commit({ 'src/main.ts': mainTs(''), 'skills/wat-audit/SKILL.md': null });
  const facts = await analyze({ cwd: r.dir, base: 'HEAD~1', now: NOW });
  assert.deepEqual(facts.parts.map((p) => [p.name, p.change, p.element]), [['audit', 'removed', 'gh'], ['wat-audit', 'removed', 'skills']]);
  assert.deepEqual(facts.diagram.reasons.slice(0, 2), ['removes the audit command in GitHub tools', 'removes the wat-audit skill in Skills']);
  const spec = toDiagramSpec(facts);
  assert.equal(spec.elements.find((e) => e.id === 'part-command-audit')!.status, 'removed');
});

test('facts: text, a version bump, CI and tests alone are skipped with the reason', async () => {
  const r = repo();
  r.commit({
    'package.json': JSON.stringify({ name: 'x', version: '1.0.0' }),
    'README.md': '# x\n',
    '.github/workflows/ci.yml': 'on: push\n',
    'src/a.ts': 'export function a(n: number): number { return n; }\n',
    'test/a.test.ts': "import { a } from '../src/a.ts';\na(1);\n",
  });
  const step = async (files: Record<string, string | null>) => { r.commit(files); return (await analyze({ cwd: r.dir, base: 'HEAD~1', now: NOW })).diagram; };
  assert.deepEqual(await step({ 'README.md': '# x\n\nMore.\n' }), { draw: false, level: null, reasons: [], skip: 'only text and documentation changed', provenance: 'exact' });
  assert.equal((await step({ 'package.json': JSON.stringify({ name: 'x', version: '1.0.1' }), 'README.md': '# x 1.0.1\n' })).skip, 'only dependency and version changes (package.json)');
  assert.equal((await step({ '.github/workflows/ci.yml': 'on: [push, pull_request]\n' })).skip, 'only CI and text files changed, and no relationship changed');
  assert.equal((await step({ 'test/a.test.ts': "import { a } from '../src/a.ts';\na(2);\n" })).skip, 'only tests changed');
  assert.equal((await step({ 'src/a.ts': '// a\nexport function a(n: number): number {\n  return n;\n}\n' })).skip, 'no declaration changed outside comments and layout');
  // A new scheduled workflow is a part, though the file is CI.
  const job = await step({ '.github/workflows/sweep.yml': "on:\n  schedule:\n    - cron: '0 6 * * 1'\n" });
  assert.equal(job.draw, true);
  assert.match(job.reasons[0]!, /^adds the sweep\.yml at 0 6 \* \* 1 scheduled job in /);
  // A change to source draws, at the code level when no part or relationship comes or goes.
  const code = await step({ 'src/a.ts': 'export function a(n: number): number { return n + 1; }\n' });
  assert.deepEqual([code.draw, code.level, code.reasons], [true, 'code', ['changes code in 1 element: src']]);
});

// ---------------------------------------------------------------- the decision alone

function facts(part: Partial<Facts>): Facts {
  return {
    schema: 1, base: 'a'.repeat(40), head: 'b'.repeat(40), range: { baseRef: 'a', headRef: 'b', workingTree: false, depth: 3 },
    diagram: { draw: false, level: null, reasons: [], skip: null, provenance: 'exact' },
    tiers: { ran: ['git', 'ast-grep', 'cccc'], languages: ['typescript'], unavailable: [] },
    summary: { filesChanged: 1, insertions: 1, deletions: 1, byKind: { source: 1 }, elementsChanged: 1, directDependents: 0, exportedSignatureChanges: 0, complexity: { functions: 0, cognitiveBefore: 0, cognitiveAfter: 0, largestRise: 0, highestAfter: 0 } },
    files: [{ path: 'src/a.ts', status: 'modified', insertions: 1, deletions: 1, kind: 'source', language: 'typescript', element: 'app', owners: [], churn90d: 0, hunkFunctions: [], provenance: 'exact', source: 'git' }],
    symbols: [{ name: 'a', kind: 'function', file: 'src/a.ts', element: 'app', exported: true, change: 'modified', signatureChanged: false, lines: 2, dependents: [], provenance: 'resolved', source: 'ast-grep' }],
    dependents: { direct: [], transitive: [] }, imports: [],
    elements: [{ id: 'app', name: 'App', type: 'container', status: 'changed', files: 3, filesChanged: 1, dependentsAffected: 0, provenance: 'exact', source: 'config' }],
    edges: [], contracts: [], tests: { changed: [], importingChanged: [] }, coChange: [], dependencies: [], parts: [], complexity: [], owners: [], caveats: [], ...part,
  };
}

test('decision: no function moved is a skip; a large rise draws code; reordered calls draw a flow; a rename is a skip', () => {
  assert.equal(decideDiagram(facts({})).skip, 'no function gained or lost a branch, no declaration was added or removed, and no relationship changed');
  const score = (before: number, after: number) => ({ file: 'src/a.ts', name: 'a', kind: 'function', line: 1, change: 'modified' as const, before: { cognitive: before, cyclomatic: 1 }, after: { cognitive: after, cyclomatic: 1 }, provenance: 'measured' as const, source: 'cccc' as const });
  const hard = decideDiagram(facts({ complexity: [score(2, 20)] }));
  assert.deepEqual([hard.draw, hard.level, hard.reasons, hard.provenance], [true, 'code', ['the logic of a (src/a.ts) changed more than a sentence can carry'], 'measured']);
  // Never a score in the words: the reasons can be pasted into a body.
  assert.doesNotMatch(hard.reasons.join(' '), /\d{2}/);
  const small = decideDiagram(facts({ complexity: [score(2, 4)] }));
  assert.deepEqual([small.level, small.reasons], ['code', ['changes code in 1 element: App']]);
  const flow = decideDiagram(facts({ complexity: [score(2, 4)], symbols: [{ ...facts({}).symbols[0]!, callsReordered: true }] }));
  assert.deepEqual([flow.level, flow.reasons, flow.provenance], ['dynamic', ['reorders the calls in a'], 'heuristic']);
  const renamed = decideDiagram(facts({ symbols: [{ ...facts({}).symbols[0]!, name: 'b', renamedFrom: 'a' }] }));
  assert.equal(renamed.skip, 'only renames');
  // An element or a relationship that comes or goes is the first reason, and draws the element level.
  const edge = decideDiagram(facts({ complexity: [score(2, 20)], elements: [...facts({}).elements, { id: 'db', name: 'DB', type: 'datastore', status: 'added', files: 1, filesChanged: 1, dependentsAffected: 0, provenance: 'exact', source: 'config' }],
    edges: [{ from: 'app', to: 'db', weight: 1, status: 'added', provenance: 'resolved', source: 'ast-grep' }] }));
  assert.deepEqual([edge.level, edge.reasons.slice(0, 2)], ['element', ['adds the element DB', 'adds the relationship App → DB']]);
  // A folder that stands in for an element and holds only notes is no new part of the system.
  const notes = decideDiagram(facts({ files: [{ ...facts({}).files[0]!, path: 'notes/a.md', kind: 'docs', language: null, element: 'notes' }], symbols: [],
    elements: [{ id: 'notes', name: 'notes', type: 'container', status: 'added', files: 1, filesChanged: 1, dependentsAffected: 0, provenance: 'heuristic', source: 'git' }] }));
  assert.equal(notes.skip, 'only text and documentation changed');
  // A schema is a contract: it draws.
  const schema = decideDiagram(facts({ files: [{ ...facts({}).files[0]!, path: 'db/schema.sql', kind: 'schema', language: null }], symbols: [], contracts: [{ path: 'db/schema.sql', kind: 'sql', note: 'modified', provenance: 'heuristic' }] }));
  assert.deepEqual([schema.draw, schema.level, schema.reasons], [true, 'element', ['changes the sql contract in db/schema.sql']]);
});

// ---------------------------------------------------------------- lint --facts

const BODY = 'The audit command was missing. This adds it.\n\n## Verify\n- [x] npm test\n';
const IMAGE = 'The audit command was missing. This adds it.\n\n<div align="center">\n\n![Change](https://example.com/a.svg)\n\n</div>\n';

test('lint --facts: warns when the facts say draw and the body has no image, and stays quiet otherwise', () => {
  const draw = { decision: { draw: true, level: 'element' as const, reasons: ['adds the audit command in GitHub tools', 'x'], skip: null, provenance: 'resolved' as const }, facts: '.wat-tmp/facts.json' };
  const res = lintBody(BODY, { kind: 'pr', diagram: draw });
  assert.deepEqual(res.errors, []);
  assert.equal(res.warnings.length, 1);
  assert.equal(res.warnings[0]!.msg, 'the facts say draw an element diagram: adds the audit command in GitHub tools (and 1 more). Draw it: npx gh-wat-dis graph from-facts .wat-tmp/facts.json | npx gh-wat-dis diagram - -o .wat-tmp/change.svg, then attach it. Leave it out only when impact gives a skip reason.');
  assert.deepEqual(lintBody(IMAGE, { kind: 'pr', diagram: draw }).warnings, []);
  assert.deepEqual(lintBody(BODY, { kind: 'issue', diagram: draw }).warnings.length, 1);
  assert.deepEqual(lintBody(BODY, { kind: 'comment', diagram: draw }).warnings, []);
  const skip = { decision: { draw: false, level: null, reasons: [], skip: 'only text and documentation changed', provenance: 'exact' as const }, facts: 'f.json' };
  assert.deepEqual(lintBody(BODY, { kind: 'pr', diagram: skip }).warnings, []);
  assert.deepEqual(lintBody(IMAGE, { kind: 'pr', diagram: skip }).warnings, []);
});

test('lint --facts: the CLI reads the facts file, decides for facts written before the decision, and keeps exit 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wat-lint-'));
  dirs.push(dir);
  const old = facts({ complexity: [{ file: 'src/a.ts', name: 'a', kind: 'function', line: 1, change: 'added', after: { cognitive: 30, cyclomatic: 9 }, provenance: 'measured', source: 'cccc' }] }) as Partial<Facts>;
  delete old.diagram;
  delete old.parts;
  writeFileSync(join(dir, 'facts.json'), JSON.stringify(old));
  writeFileSync(join(dir, 'pr.md'), BODY);
  const out = execFileSync(process.execPath, [BIN, 'lint', join(dir, 'pr.md'), '--kind', 'pr', '--facts', join(dir, 'facts.json')], { encoding: 'utf8' });
  assert.match(out, /warn .* the facts say draw a code diagram: the logic of a \(src\/a\.ts\) changed more than a sentence can carry\. Draw it: npx gh-wat-dis graph from-facts .*facts\.json --level file/);
  assert.match(out, /0 errors, 1 warnings\./);
  writeFileSync(join(dir, 'bad.json'), '{"not":"facts"}');
  assert.throws(() => execFileSync(process.execPath, [BIN, 'lint', join(dir, 'pr.md'), '--kind', 'pr', '--facts', join(dir, 'bad.json')], { stdio: 'pipe' }), (e: { status?: number }) => e.status === 2);
});
