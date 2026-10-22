import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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


test('uninstall: preserves edited skills, previews both plans, and removes edits only with --force', () => {
  const cwd = project();
  const home = dir('wat-home-');
  const cli = fileURLToPath(new URL('../src/bin.ts', import.meta.url));
  const invoke = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, HOME: home, PATH: home },
  });
  // Install with no external tools available: the doctor can fail after the skills are written.
  const install = invoke('install', '--project', '--client', 'agents', '--no-config', '--mcp', 'skip');
  assert.match(install.stdout, new RegExp(`${skillNames().length} skill directories written`));
  const root = join(cwd, '.agents/skills');
  const edited = join(root, 'wat-issue');
  const original = readFileSync(join(edited, 'SKILL.md'), 'utf8');
  writeFileSync(join(edited, 'SKILL.md'), original + '\nMy changes.\n');
  const other = join(root, 'my-skill');
  mkdirSync(other);
  writeFileSync(join(other, MANIFEST), JSON.stringify({ package: 'someone-else' }));
  const unchanged = join(root, 'wat');
  const count = skillNames().length;

  const dry = invoke('uninstall', '--project', '--client', 'agents', '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /skip +.*wat-issue +\(edited by hand since install\)/);
  assert.match(dry.stdout, new RegExp(`${count - 1} skill directories would be removed, 1 skipped`));
  assert.match(dry.stdout, /--force to remove them/);
  assert.equal(existsSync(unchanged), true);

  const forceDry = invoke('uninstall', '--project', '--client', 'agents', '--force', '--dry-run');
  assert.equal(forceDry.status, 0, forceDry.stderr);
  assert.match(forceDry.stdout, new RegExp(`${count} skill directories would be removed, 0 skipped`));
  assert.equal(existsSync(edited), true);
  assert.equal(existsSync(unchanged), true);

  const normal = invoke('uninstall', '--project', '--client', 'agents');
  assert.equal(normal.status, 0, normal.stderr);
  assert.match(normal.stdout, new RegExp(`${count - 1} skill directories removed, 1 skipped`));
  assert.equal(readFileSync(join(edited, 'SKILL.md'), 'utf8'), original + '\nMy changes.\n');
  assert.equal(existsSync(unchanged), false);
  assert.equal(existsSync(other), true);

  const forced = invoke('uninstall', '--project', '--client', 'agents', '-f');
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /1 skill directories removed, 0 skipped/);
  assert.equal(existsSync(edited), false);
  assert.equal(existsSync(other), true);
});

test('dis cache: install ignore rule preserves entries and doctor catches tracked or unignored cache files', async () => {
  const { ensureDisIgnore, DIS_CACHE_REL } = await import('../src/cli/dis-ignore.ts');
  const { checkDisCache } = await import('../src/cli/doctor.ts');
  const cwd = project();
  const git = (...args: string[]) => {
    const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout;
  };
  git('init', '-q');
  assert.equal(checkDisCache(cwd)[0]?.status, 'fix');
  const ignore = join(cwd, '.agents/gh-wat-dis/.gitignore');
  mkdirSync(join(cwd, '.agents/gh-wat-dis'), { recursive: true });
  writeFileSync(ignore, '.env\ncustom/');
  assert.equal(ensureDisIgnore(cwd, true), true);
  assert.equal(readFileSync(ignore, 'utf8'), '.env\ncustom/');
  assert.equal(ensureDisIgnore(cwd), true);
  assert.equal(readFileSync(ignore, 'utf8'), '.env\ncustom/\ndis/\n');
  assert.equal(ensureDisIgnore(cwd), false);
  assert.equal(checkDisCache(cwd)[0]?.status, 'ok');
  mkdirSync(join(cwd, DIS_CACHE_REL, 'owner/repo/1'), { recursive: true });
  writeFileSync(join(cwd, DIS_CACHE_REL, 'owner/repo/1/explain.md'), 'private thread');
  assert.equal(git('status', '--short', '--', DIS_CACHE_REL), '');
  git('add', '-f', '--', DIS_CACHE_REL);
  assert.match(checkDisCache(cwd)[0]?.detail ?? '', /tracked files/);
});


test('uninstall: nested directory, file and broken symlinks count as edits without following their targets', () => {
  const cwd = project();
  installed(cwd, '0.1.1');
  const edited = join(cwd, '.agents/skills/wat');
  const external = project();
  const target = join(external, 'keep.txt');
  writeFileSync(target, 'external content');
  symlinkSync(external, join(edited, 'external-directory'));
  symlinkSync(target, join(edited, 'external-file'));
  symlinkSync(join(external, 'missing'), join(edited, 'broken-link'));
  const before = hashDir(edited);
  writeFileSync(target, 'changed outside the skill');
  assert.equal(hashDir(edited), before, 'ownership hash must not read through the links');
  const cli = fileURLToPath(new URL('../src/bin.ts', import.meta.url));
  const invoke = (...args: string[]) => spawnSync(process.execPath, [cli, 'uninstall', '--project', '--client', 'agents', ...args], { cwd, encoding: 'utf8' });
  const normal = invoke();
  assert.equal(normal.status, 0, normal.stderr);
  assert.match(normal.stdout, /1 skipped/);
  assert.equal(existsSync(edited), true);
  assert.equal(existsSync(join(cwd, '.agents/skills/wat-pr')), false, 'later unchanged skills are still removed');
  const force = invoke('--force');
  assert.equal(force.status, 0, force.stderr);
  assert.equal(existsSync(edited), false);
  assert.equal(readFileSync(target, 'utf8'), 'changed outside the skill');
});
