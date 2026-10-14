import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkMcp, checkSkills } from '../src/cli/doctor.ts';
import { MANIFEST, hashDir, skillNames, skillSource } from '../src/cli/install.ts';
import { applyClient } from '../src/cli/mcp-apply.ts';
import { parseJsonc } from '../src/cli/util.ts';

const dir = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
/** A project that is not a git repository: package.json marks its root. */
const project = (): string => { const p = dir('wat-proj-'); writeFileSync(join(p, 'package.json'), '{}'); return p; };

/** Copies the shipped skills into a user folder the way install does, as written by `version`. */
function installed(home: string, version: string, change?: string): void {
  for (const name of skillNames()) {
    const dest = join(home, '.agents/skills', name);
    mkdirSync(dest, { recursive: true });
    cpSync(skillSource(name), dest, { recursive: true });
    if (name === change) writeFileSync(join(dest, 'SKILL.md'), 'the text an older version shipped\n');
    writeFileSync(join(dest, MANIFEST), JSON.stringify({ package: 'gh-wat-dis', version, hash: hashDir(dest) }));
  }
}

test('doctor: skills an older version wrote are current when their files are the ones this version ships', () => {
  const home = dir('wat-home-');
  installed(home, '0.0.1');
  const [same, ...rest] = checkSkills(project(), home);
  assert.equal(rest.length, 0);
  assert.equal(same!.status, 'ok');
  assert.match(same!.detail, new RegExp(`^${skillNames().length} skills installed`));

  const stale = dir('wat-home-');
  installed(stale, '0.0.1', 'wat-pr');
  const [old] = checkSkills(project(), stale);
  assert.equal(old!.status, 'fix');
  assert.match(old!.detail, /^1 from an older version, in /);
  assert.equal(old!.action, 'run: npx gh-wat-dis install');
});

test('doctor: finds the project-level entries that mcp --apply --scope project writes', async () => {
  const cwd = project();
  const home = dir('wat-home-');
  assert.equal((await checkMcp(cwd, true, home)).code, 'mcp-none');
  for (const c of ['codex', 'opencode', 'gemini']) assert.equal(applyClient(c, { scope: 'project', home, cwd }).action, 'added');
  const check = await checkMcp(cwd, true, home);
  assert.notEqual(check.code, 'mcp-none');
  assert.match(check.detail, /^set up for Codex \(project\), Gemini CLI \(project\), OpenCode \(project\)/);
});

test('doctor: reads an OpenCode config with comments', async () => {
  const home = dir('wat-home-');
  mkdirSync(join(home, '.config/opencode'), { recursive: true });
  writeFileSync(join(home, '.config/opencode/opencode.jsonc'), '{\n  // mine\n  "mcp": { "github": { "type": "remote", "url": "https://api.githubcopilot.com/mcp/", }, },\n}\n');
  assert.match((await checkMcp(project(), true, home)).detail, /^set up for OpenCode/);
});

test('apply: an entry in opencode.jsonc counts as set up, and a jsonc without one is left as it is', () => {
  const has = dir('wat-home-');
  mkdirSync(join(has, '.config/opencode'), { recursive: true });
  writeFileSync(join(has, '.config/opencode/opencode.jsonc'), '{\n  // mine\n  "mcp": { "GitHub": { "type": "remote", "url": "https://example.com/mcp" } }\n}\n');
  assert.equal(applyClient('opencode', { scope: 'user', home: has }).action, 'exists');
  assert.equal(existsSync(join(has, '.config/opencode/opencode.json')), false);

  const cwd = project();
  const original = '{\n  // "mcp": { "github": {} } is not set up yet\n  "username": "me",\n}\n';
  writeFileSync(join(cwd, 'opencode.jsonc'), original);
  assert.equal(applyClient('opencode', { scope: 'project', home: has, cwd }).action, 'added');
  assert.equal(readFileSync(join(cwd, 'opencode.jsonc'), 'utf8'), original);
  assert.equal(JSON.parse(readFileSync(join(cwd, 'opencode.json'), 'utf8')).mcp.github.type, 'remote');
});

test('apply: says that Codex reads a project file only in a trusted project', () => {
  const home = dir('wat-home-');
  const res = applyClient('codex', { scope: 'project', home, cwd: project() });
  assert.equal(res.action, 'added');
  assert.match(res.detail ?? '', /only in a project it trusts/);
  assert.equal(applyClient('codex', { scope: 'user', home }).detail, undefined);
});

test('parseJsonc: drops comments and trailing commas, and keeps both inside strings', () => {
  assert.deepEqual(parseJsonc('{ /* a */ "url": "https://x/y", // b\n "s": "a, ] /* c */", "l": [1, 2,], }'), { url: 'https://x/y', s: 'a, ] /* c */', l: [1, 2] });
});
