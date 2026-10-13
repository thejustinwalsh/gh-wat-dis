import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig } from '../src/cli/config.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
type Schema = { type?: string | string[]; enum?: unknown[]; const?: unknown; required?: string[]; additionalProperties?: boolean; properties?: Record<string, Schema>; items?: Schema };

/** Enough of JSON Schema to check a config: types, enums, required keys and unknown keys. */
function check(value: unknown, schema: Schema, path = '$'): string[] {
  const errors: string[] = [];
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  const allowed = schema.type === undefined ? undefined : [schema.type].flat();
  if (allowed && !allowed.includes(kind) && !(kind === 'integer' && allowed.includes('number'))) errors.push(`${path}: is ${kind}, expected ${allowed.join(' or ')}`);
  if (kind === 'object' && schema.properties) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) errors.push(`${path}: missing "${key}"`);
    for (const [key, v] of Object.entries(obj)) {
      const sub = schema.properties[key];
      if (sub) errors.push(...check(v, sub, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: unknown key "${key}"`);
    }
  }
  if (kind === 'array' && schema.items) (value as unknown[]).forEach((v, i) => errors.push(...check(v, schema.items!, `${path}[${i}]`)));
  return errors;
}

test('config schema: accepts what init writes and this repository uses, and rejects a bad value', () => {
  const schema = JSON.parse(readFileSync(join(root, 'docs/config.schema.json'), 'utf8')) as Schema;
  assert.deepEqual(check(defaultConfig({ owner: 'o', name: 'r' }), schema), []);
  assert.deepEqual(check(defaultConfig({ owner: 'o', name: 'r', issueTypes: ['Task'] }), schema), []);
  assert.deepEqual(check(JSON.parse(readFileSync(join(root, '.agents/gh-wat-dis/config.json'), 'utf8')), schema), []);
  const bad = { ...defaultConfig(), policy: { use: 'sometimes' }, extra: 1 };
  assert.equal(check(bad, schema).length, 2);
  assert.equal((schema as { $id?: string }).$id, defaultConfig().$schema, 'init must write the URL the schema is served from');
});

test('skills: every file a skill links to ships inside the skills folder', () => {
  const skills = join(root, 'skills');
  const missing: string[] = [];
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith('.md') ? [join(dir, d.name)] : []));
  for (const file of walk(skills)) {
    const text = readFileSync(file, 'utf8').replace(/^```[\s\S]*?^```/gm, '');
    const targets = [
      ...[...text.replace(/`[^`\n]*`/g, '').matchAll(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g)].map((m) => m[1]!),
      ...[...text.matchAll(/`(\.\.\/[\w./-]+\.md)`/g)].map((m) => m[1]!),
    ].filter((t) => !t.startsWith('./<') && !t.includes('<'));
    for (const t of targets) {
      const target = resolve(dirname(file), t.split('#')[0]!);
      if (!target.startsWith(skills) || !existsSync(target)) missing.push(`${file.slice(root.length + 1)} -> ${t}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('cli: help lists every tool, and every tool prints its usage for --help', async () => {
  const { TOOLS, helpText } = await import('../src/main.ts');
  const run = (...args: string[]) => spawnSync(process.execPath, [join(root, 'src/bin.ts'), ...args], { encoding: 'utf8' });
  const listed = JSON.parse(run('help', '--json').stdout) as { tools: typeof TOOLS };
  assert.deepEqual(listed.tools, TOOLS);
  assert.equal(new Set(TOOLS.map((t) => t.name)).size, TOOLS.length, 'tool names are unique');

  // The command table in main.ts and the tool list name the same commands.
  const main = readFileSync(join(root, 'src/main.ts'), 'utf8');
  const table = main.slice(main.indexOf('const COMMANDS'), main.indexOf('};', main.indexOf('const COMMANDS')));
  const commands = [...table.matchAll(/^\s+'?([a-z-]+)'?: async/gm)].map((m) => m[1]!).sort();
  assert.deepEqual([...new Set(TOOLS.map((t) => t.name.split(' ')[0]!))].sort(), commands);

  const text = helpText();
  for (const t of TOOLS) {
    assert.ok(text.includes(`  ${t.name} `), `help lists ${t.name}`);
    assert.ok(t.description.length > 20 && t.description.endsWith('.'), `${t.name} has a description`);
    assert.ok(t.usage.startsWith(t.name), `${t.name} usage starts with its name`);
  }
  for (const c of commands) {
    const r = run(c, '--help');
    assert.equal(r.status, 0, `${c} --help exited ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, /Usage|usage/, `${c} --help prints no usage`);
  }
});
