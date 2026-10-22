import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
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


test('dis measure: HTTPS auth falls back to gh per fetch, preserves existing helpers, and refuses other credential hosts', async (t) => {
  const { root, source, caller, temp, trace, item } = fixture(t);
  const vars = ['PATH', 'GH_TOKEN', 'GIT_TERMINAL_PROMPT', 'NO_PROXY', 'no_proxy', 'WAT_AUTH_LOG', 'WAT_AUTH_FULL'];
  const old = new Map(vars.map((key) => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of old) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const bin = join(root, 'bin'), repositories = join(root, 'repositories'), calls = join(root, 'helpers.log');
  mkdirSync(bin); mkdirSync(join(repositories, 'acme'), { recursive: true });
  const remote = join(repositories, 'acme/example.git');
  git(root, 'clone', '-q', '--bare', source, remote);
  git(remote, 'update-ref', 'refs/pull/7/head', item.headSha);
  git(remote, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
  const token = 'scratch-token-never-use-on-github';
  Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: token, GIT_TERMINAL_PROMPT: '0', WAT_AUTH_LOG: calls });
  delete process.env.NO_PROXY; delete process.env.no_proxy;
  writeFileSync(calls, '');
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const { appendFileSync } = require('node:fs');
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', s => input += s);
process.stdin.on('end', () => {
  const fields = Object.fromEntries(input.split('\\n').filter(Boolean).map(line => { const i = line.indexOf('='); return [line.slice(0,i),line.slice(i+1)]; }));
  const action = process.argv.at(-1);
  appendFileSync(process.env.WAT_AUTH_LOG, 'gh ' + action + ' ' + fields.host + '\\n');
  if (action === 'get' && fields.host === 'github.com') process.stdout.write('username=token-user\\npassword=' + process.env.GH_TOKEN + '\\n\\n');
});
`, { mode: 0o755 });
  const existing = join(root, 'existing-helper.cjs');
  writeFileSync(existing, `const { appendFileSync } = require('node:fs');
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', s => input += s);
process.stdin.on('end', () => {
  const action = process.argv.at(-1); appendFileSync(process.env.WAT_AUTH_LOG, 'existing ' + action + '\\n');
  if (action === 'get') process.stdout.write('username=token-user\\n' + (process.env.WAT_AUTH_FULL ? 'password=' + process.env.GH_TOKEN + '\\n' : '') + '\\n');
});
`);
  git(source, 'config', '--global', 'credential.helper', `!"${process.execPath}" "${existing}"`);
  git(source, 'config', '--global', '--unset-all', `url.${pathToFileURL(source).href}.insteadOf`);
  // A local HTTP proxy keeps the requested credential host github.com without contacting GitHub.
  // The helper is a host-scoped stand-in; the token is a scratch value and never enters argv.
  git(source, 'config', '--global', 'url.http://github.com/acme/example.git.insteadOf', 'https://github.com/acme/example.git');
  let authorized = 0;
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Basic ${Buffer.from(`token-user:${token}`).toString('base64')}`) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="scratch repository"' }); response.end(); return;
    }
    authorized++;
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const target = new URL(request.url!, 'http://github.com');
    try {
      const body = Buffer.concat(chunks);
      const out = execFileSync('git', ['http-backend'], { input: body, maxBuffer: 16 * 1024 * 1024, env: {
        ...process.env, GIT_PROJECT_ROOT: repositories, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: target.pathname,
        QUERY_STRING: target.search.slice(1), REQUEST_METHOD: request.method!, CONTENT_TYPE: request.headers['content-type'] ?? '', CONTENT_LENGTH: String(body.length), REMOTE_USER: 'token-user',
      } });
      const split = out.indexOf('\r\n\r\n');
      const headers: Record<string, string> = {}; let status = 200;
      for (const line of out.subarray(0, split).toString().split('\r\n')) {
        const colon = line.indexOf(':'); if (colon < 0) continue;
        const key = line.slice(0, colon), value = line.slice(colon + 1).trim();
        if (key.toLowerCase() === 'status') status = Number(value.split(' ')[0]); else headers[key] = value;
      }
      response.writeHead(status, headers); response.end(out.subarray(split + 4));
    } catch { response.writeHead(500); response.end('scratch Git transport failed'); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    git(source, 'config', '--global', 'http.proxy', `http://127.0.0.1:${address.port}`);
    const config = join(root, 'gitconfig'), before = readFileSync(config, 'utf8');
    const facts = await measurePr(item, { cwd: caller, tempRoot: temp });
    assert.equal(facts.base, item.baseSha); assert.equal(facts.head, item.headSha);
    const fallback = readFileSync(calls, 'utf8');
    assert.match(fallback, /existing get/);
    assert.ok(fallback.indexOf('existing get') < fallback.indexOf('gh get github.com'));
    assert.match(fallback, /gh get github.com/);
    assert.ok(authorized > 0);
    assert.equal(readFileSync(config, 'utf8'), before, 'auth must not change user config');
    assert.deepEqual(readdirSync(temp), []);

    const clone = join(root, 'auth-clone');
    git(root, 'clone', '-q', source, clone);
    git(clone, 'remote', 'set-url', 'origin', 'https://github.com/acme/example.git');
    writeFileSync(calls, '');
    await measurePr(item, { cwd: clone, tempRoot: temp });
    assert.match(readFileSync(calls, 'utf8'), /gh get github.com/, 'HTTPS clones need the fallback too');
    assert.equal(readFileSync(config, 'utf8'), before);

    writeFileSync(calls, ''); process.env.WAT_AUTH_FULL = '1';
    await measurePr(item, { cwd: caller, tempRoot: temp });
    assert.match(readFileSync(calls, 'utf8'), /existing get/);
    assert.doesNotMatch(readFileSync(calls, 'utf8'), /gh get/, 'a complete user helper must win');
    assert.equal(readFileSync(config, 'utf8'), before);

    delete process.env.WAT_AUTH_FULL;
    git(source, 'config', '--global', '--unset-all', 'credential.helper');
    git(source, 'config', '--global', '--unset-all', 'url.http://github.com/acme/example.git.insteadOf');
    git(source, 'config', '--global', 'url.http://other.invalid/acme/example.git.insteadOf', 'https://github.com/acme/example.git');
    writeFileSync(calls, ''); const priorAuthorized = authorized;
    await assert.rejects(measurePr(item, { cwd: caller, tempRoot: temp }), /could not read Username|Authentication failed/);
    assert.match(readFileSync(calls, 'utf8'), /gh get other.invalid/);
    assert.equal(authorized, priorAuthorized, 'the gh helper must not return credentials for a rewritten host');
    assert.deepEqual(readdirSync(temp), []);
    assert.doesNotMatch(readFileSync(trace, 'utf8'), new RegExp(token));
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
