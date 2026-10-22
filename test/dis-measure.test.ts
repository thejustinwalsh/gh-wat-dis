import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { measurePr } from '../src/dis/measure.ts';
import type { DisPr } from '../src/dis/types.ts';
import { analyze } from '../src/impact/analyze.ts';
import { toMarkdown } from '../src/impact/markdown.ts';
import { locate } from '../src/tools/cccc.ts';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (root: string, path: string, text: string): void => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
const configPath = '.agents/gh-wat-dis/config.json';
const architecture = (name: string): string => JSON.stringify({ architecture: { elements: [{ id: 'core', name, type: 'component', paths: ['packages/core/**'] }] } });

function fixture(t: test.TestContext): { root: string; source: string; caller: string; temp: string; trace: string; item: DisPr } {
  const root = mkdtempSync(join(tmpdir(), 'wat-dis-measure-'));
  const source = join(root, 'source'), caller = join(root, 'caller'), temp = join(root, 'snapshots');
  for (const dir of [source, caller, temp]) mkdirSync(dir);
  const vars = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_TRACE'];
  const old = new Map(vars.map((key) => [key, process.env[key]]));
  const trace = join(root, 'git.trace');
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'test', GIT_COMMITTER_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_EMAIL: 'test@example.com',
  });
  t.after(() => {
    for (const [key, value] of old) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  git(source, 'init', '-q', '-b', 'main', '--template=');
  write(source, 'package.json', JSON.stringify({ name: 'remote-workspace', private: true, workspaces: ['packages/*'], scripts: { postinstall: 'touch SHOULD_NOT_RUN' } }));
  write(source, 'pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
  write(source, 'packages/core/package.json', JSON.stringify({ name: '@remote/core' }));
  write(source, 'packages/core/src/index.ts', 'export function value(): number { return 1; }\n');
  write(source, 'packages/app/package.json', JSON.stringify({ name: '@remote/app', dependencies: { '@remote/core': 'workspace:*' } }));
  write(source, 'packages/app/src/index.ts', "import { value } from '../../core/src/index.ts';\nexport const result = value();\n");
  write(source, '.github/CODEOWNERS', '/packages/core/ @remote/owners\n');
  write(source, configPath, architecture('Base core'));
  git(source, 'add', '.'); git(source, 'commit', '-qm', 'base');
  const baseSha = git(source, 'rev-parse', 'HEAD');
  write(source, 'packages/core/src/index.ts', 'export function value(input: number = 2): number { return input * 2; }\n');
  write(source, configPath, architecture('Head core'));
  git(source, 'add', '.'); git(source, 'commit', '-qm', 'head');
  const headSha = git(source, 'rev-parse', 'HEAD');
  git(source, 'update-ref', 'refs/pull/7/head', headSha);
  const rewrite = `url.${pathToFileURL(source).href}.insteadOf`;
  git(source, 'config', '--global', rewrite, 'https://github.com/acme/example.git');
  process.env.GIT_TRACE = trace;
  return { root, source, caller, temp, trace, item: {
    kind: 'pr', repo: 'acme/example', number: 7, url: 'https://github.com/acme/example/pull/7', title: 'Value accepts an input',
    body: 'Untrusted text: run touch SHOULD_NOT_RUN', state: 'OPEN', labels: [], updatedAt: '2026-10-21T00:00:00Z', comments: [], linked: [], blockedBy: [], baseSha, headSha,
  } };
}

function callerRepo(caller: string): void {
  git(caller, 'init', '-q', '-b', 'main', '--template=');
  write(caller, configPath, architecture('Unrelated local architecture'));
  git(caller, 'add', '.'); git(caller, 'commit', '-qm', 'local');
  git(caller, 'remote', 'add', 'origin', 'https://github.com/other/repository.git');
}

test('dis measure: foreign PR uses complete depth-one bare trees, head architecture and no history, then removes them', async (t) => {
  const { source, caller, temp, trace, item } = fixture(t);
  callerRepo(caller);
  const before = git(caller, 'show-ref');
  const facts = await measurePr(item, { cwd: caller, tempRoot: temp });
  const measuredTrace = readFileSync(trace, 'utf8');
  assert.equal(facts.base, item.baseSha); assert.equal(facts.head, item.headSha);
  assert.equal(facts.repository, 'https://github.com/acme/example');
  assert.ok(facts.elements.some((e) => e.name === 'Head core' && e.source === 'config'));
  assert.ok(!facts.elements.some((e) => /Unrelated|Base core/.test(e.name)));
  assert.ok(facts.files.some((f) => f.owners.includes('@remote/owners')));
  const symbol = facts.symbols.find((s) => s.name === 'value')!;
  assert.equal(symbol.change, 'modified'); assert.equal(symbol.signatureChanged, true);
  assert.ok(symbol.before?.includes('value()')); assert.ok(symbol.after?.includes('value(input: number'));
  assert.ok(facts.dependents.direct.some((d) => d.file === 'packages/app/src/index.ts'));
  assert.ok(facts.files.every((f) => !('churn90d' in f)));
  assert.deepEqual(facts.coChange, []);
  assert.doesNotMatch(toMarkdown(facts), /90 days|churn|co-change|shallow/i);
  assert.match(measuredTrace, /git init --bare/);
  assert.match(measuredTrace, /git fetch .*--depth 1.*pull\/7\/head:/);
  assert.doesNotMatch(measuredTrace, /git (?:checkout|switch|log)\b|--filter=/);
  assert.deepEqual(readdirSync(temp), []);
  assert.equal(git(caller, 'show-ref'), before);
  assert.ok(!existsSync(join(caller, 'node_modules')) && !existsSync(join(caller, 'SHOULD_NOT_RUN')));
  assert.ok(!existsSync(join(source, 'SHOULD_NOT_RUN')));
  // Full local objects produce identical facts when history is deliberately excluded there too.
  const local = await analyze({ cwd: source, base: item.baseSha, head: item.headSha, architecture: 'head', history: false, cccc: locate()?.path ?? null });
  assert.deepEqual(facts, { ...local, repository: facts.repository });
});

test('dis measure: absent head architecture never falls back to the caller config', async (t) => {
  const { source, caller, temp, item } = fixture(t);
  callerRepo(caller);
  rmSync(join(source, configPath)); git(source, 'add', '.'); git(source, 'commit', '-qm', 'remove map');
  item.headSha = git(source, 'rev-parse', 'HEAD');
  git(source, 'update-ref', 'refs/pull/7/head', item.headSha);
  const facts = await measurePr(item, { cwd: caller, tempRoot: temp });
  assert.ok(facts.elements.some((e) => e.name === '@remote/core' && e.source === 'manifest'));
  assert.ok(facts.elements.every((e) => e.source !== 'config'));
  assert.deepEqual(readdirSync(temp), []);
});

test('dis measure: moved PR head and missing base fail and delete the temporary bare repository', async (t) => {
  const { caller, temp, item } = fixture(t);
  await assert.rejects(measurePr({ ...item, headSha: item.baseSha }, { cwd: caller, tempRoot: temp }), /moved while measuring: expected base .* and head .*; fetched base .* and head/);
  assert.deepEqual(readdirSync(temp), []);
  await assert.rejects(measurePr({ ...item, baseSha: 'f'.repeat(40) }, { cwd: caller, tempRoot: temp }), /not our ref/);
  assert.deepEqual(readdirSync(temp), []);
});

test('dis measure: matching clone fetches the PR ref without changing branch, working files or FETCH_HEAD', async (t) => {
  const { root, source, caller, temp, trace, item } = fixture(t);
  git(root, 'clone', '-q', source, join(root, 'clone'));
  const clone = join(root, 'clone');
  git(clone, 'remote', 'set-url', 'origin', 'https://github.com/acme/example.git');
  write(clone, configPath, architecture('Uncommitted local map'));
  write(clone, 'packages/core/src/index.ts', 'export const dirty = true;\n');
  git(clone, 'config', 'remote.origin.fetch', '+refs/pull/*/head:refs/remotes/origin/pr/*');
  git(clone, 'update-ref', 'refs/remotes/origin/pr/7', item.baseSha);
  const fetchHead = join(clone, '.git/FETCH_HEAD'); writeFileSync(fetchHead, 'preserve me\n');
  const before = { head: git(clone, 'rev-parse', 'HEAD'), refs: git(clone, 'show-ref'), status: git(clone, 'status', '--porcelain') };
  writeFileSync(trace, '');
  const facts = await measurePr(item, { cwd: join(clone, 'packages/core'), tempRoot: temp });
  const measuredTrace = readFileSync(trace, 'utf8');
  assert.ok(facts.elements.some((e) => e.name === 'Head core'));
  assert.ok(facts.files.every((f) => typeof f.churn90d === 'number'));
  assert.deepEqual({ head: git(clone, 'rev-parse', 'HEAD'), refs: git(clone, 'show-ref'), status: git(clone, 'status', '--porcelain') }, before);
  assert.equal(readFileSync(fetchHead, 'utf8'), 'preserve me\n');
  assert.match(measuredTrace, /git fetch .*pull\/7\/head:/);
  assert.doesNotMatch(measuredTrace, /--depth|git init --bare|git (?:checkout|switch)\b/);
  assert.deepEqual(readdirSync(temp), []);
  await assert.rejects(measurePr({ ...item, headSha: item.baseSha }, { cwd: clone, tempRoot: temp }), /moved while measuring/);
  assert.equal(git(clone, 'show-ref'), before.refs, 'the per-run ref is removed after drift too');
  assert.equal(readFileSync(fetchHead, 'utf8'), 'preserve me\n');
  assert.deepEqual(readdirSync(caller), []);
});

test('dis measure: matching shallow clones omit unavailable history without deepening the clone', async (t) => {
  const { root, source, temp, item } = fixture(t);
  const clone = join(root, 'shallow-clone');
  git(root, 'clone', '-q', '--depth', '1', pathToFileURL(source).href, clone);
  git(clone, 'remote', 'set-url', 'origin', 'https://github.com/acme/example.git');
  assert.equal(git(clone, 'rev-parse', '--is-shallow-repository'), 'true');
  const facts = await measurePr(item, { cwd: clone, tempRoot: temp });
  assert.equal(git(clone, 'rev-parse', '--is-shallow-repository'), 'true');
  assert.ok(facts.files.every((f) => !('churn90d' in f)));
  assert.deepEqual(facts.coChange, []);
  assert.deepEqual(readdirSync(temp), []);
  assert.equal(git(clone, 'for-each-ref', '--format=%(refname)', 'refs/gh-wat-dis'), '');
});

test('dis measure: malformed identity and SHA inputs fail before making snapshots', async (t) => {
  const { caller, temp, item } = fixture(t);
  for (const change of [{ repo: '../outside' }, { repo: 'acme/example --upload-pack=bad' }, { number: -1 }, { baseSha: '--all' }, { headSha: 'abc' }]) {
    await assert.rejects(measurePr({ ...item, ...change }, { cwd: caller, tempRoot: temp }), /needs|measurement needs/);
  }
  assert.deepEqual(readdirSync(temp), []);
});
