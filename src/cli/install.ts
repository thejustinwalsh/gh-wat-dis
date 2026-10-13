import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { PKG, PKG_ROOT, UsageError, parseArgs, readJson, repoRoot } from './util.ts';

export const MANIFEST = '.gh-wat-dis.json';
const SKILLS_SRC = join(PKG_ROOT, 'skills');

const CLIENTS = {
  agents: { dir: '.agents/skills', label: 'Codex, Cursor, Gemini CLI, OpenCode, Copilot' },
  claude: { dir: '.claude/skills', label: 'Claude Code' },
} as const;
export type Client = keyof typeof CLIENTS;
const CLIENT_NAMES = Object.keys(CLIENTS) as Client[];

export interface Manifest { package: string; version: string; hash: string }
export interface Target { client: Client; root: string; label: string }
export type Action = 'install' | 'update' | 'replace' | 'current' | 'skip';
export interface Step { action: Action; name: string; src: string; dest: string; client: Client; note: string; hash: string }

export function skillNames(): string[] {
  return readdirSync(SKILLS_SRC, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(SKILLS_SRC, d.name, 'SKILL.md')))
    .map((d) => d.name)
    .sort();
}

function listFiles(dir: string, base: string = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d): string[] => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return listFiles(p, base);
    return d.name === MANIFEST ? [] : [relative(base, p)];
  }).sort();
}

export function hashDir(dir: string): string {
  const h = createHash('sha256');
  for (const f of listFiles(dir)) h.update(f).update('\0').update(readFileSync(join(dir, f))).update('\0');
  return h.digest('hex');
}

export interface Scope { project?: boolean; clients: Client[]; cwd?: string; home?: string }

export function targets({ project = false, clients, cwd = process.cwd(), home = homedir() }: Scope): Target[] {
  const base = project ? repoRoot(cwd) : home;
  return clients.map((c) => ({ client: c, root: join(base, CLIENTS[c].dir), label: CLIENTS[c].label }));
}

export function parseClients(value: string | undefined): Client[] {
  if (!value || value === 'all') return CLIENT_NAMES;
  const list = value.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = list.find((c) => !(c in CLIENTS));
  if (bad) throw new UsageError(`unknown client "${bad}". Use: ${CLIENT_NAMES.join(', ')}, all`);
  return list as Client[];
}

export function plan(scope: Scope & { force?: boolean }): Step[] {
  const steps: Step[] = [];
  for (const t of targets(scope)) {
    for (const name of skillNames()) {
      const src = join(SKILLS_SRC, name);
      const dest = join(t.root, name);
      const hash = hashDir(src);
      const blocked: Action = scope.force ? 'replace' : 'skip';
      let action: Action = 'install';
      let note = '';
      if (existsSync(dest)) {
        const m = readJson<Manifest>(join(dest, MANIFEST));
        if (lstatSync(dest).isSymbolicLink()) { action = blocked; note = 'symlink, not managed by gh-wat-dis'; }
        else if (!m) { action = blocked; note = 'exists, not installed by gh-wat-dis'; }
        else if (hashDir(dest) !== m.hash) { action = blocked; note = 'edited by hand since install'; }
        else if (m.hash === hash) action = 'current';
        else { action = 'update'; note = `${m.version} -> ${PKG.version}`; }
      }
      steps.push({ action, name, src, dest, client: t.client, note, hash });
    }
  }
  return steps;
}

function apply(step: Step): void {
  if (step.action === 'skip' || step.action === 'current') return;
  rmSync(step.dest, { recursive: true, force: true });
  mkdirSync(step.dest, { recursive: true });
  cpSync(step.src, step.dest, { recursive: true });
  const manifest: Manifest = { package: PKG.name, version: PKG.version, hash: step.hash };
  writeFileSync(join(step.dest, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
}

export async function install(argv: string[]): Promise<number> {
  const args = parseArgs(argv, {
    booleans: ['project', 'dry-run', 'force'], strings: ['client'],
    aliases: { '-n': '--dry-run', '-f': '--force', '-c': '--client', '-p': '--project' },
  });
  const steps = plan({ project: args.project, clients: parseClients(args.client), force: args.force });
  for (const s of steps) console.log(`${s.action.padEnd(8)} ${s.dest}${s.note ? `  (${s.note})` : ''}`);
  if (args['dry-run']) {
    console.log('\nDry run. Nothing changed.');
    return 0;
  }
  steps.forEach(apply);
  const count = (...a: Action[]): number => steps.filter((s) => a.includes(s.action)).length;
  const changed = count('install', 'update', 'replace');
  console.log(`\n${changed} skill directories written, ${count('current')} current, ${count('skip')} skipped.`);
  if (count('skip')) console.log('Skipped directories were not touched. Run again with --force to replace them.');
  if (changed) console.log('Restart your agent harness so it loads the skills.');

  console.log('\nChecks');
  const { offerLogin, printChecks, runChecks } = await import('./doctor.ts');
  let checks = await runChecks();
  let fails = printChecks(checks);
  if (await offerLogin(checks)) {
    console.log('\nChecking again');
    checks = await runChecks();
    fails = printChecks(checks);
  }
  return count('skip') || fails ? 1 : 0;
}

export async function uninstall(argv: string[]): Promise<number> {
  const args = parseArgs(argv, {
    booleans: ['project', 'dry-run'], strings: ['client'],
    aliases: { '-n': '--dry-run', '-c': '--client', '-p': '--project' },
  });
  let removed = 0;
  for (const t of targets({ project: args.project, clients: parseClients(args.client) })) {
    if (!existsSync(t.root)) continue;
    for (const d of readdirSync(t.root, { withFileTypes: true })) {
      const dest = join(t.root, d.name);
      if (!d.isDirectory() || readJson<Manifest>(join(dest, MANIFEST))?.package !== PKG.name) continue;
      console.log(`remove   ${dest}`);
      if (!args['dry-run']) rmSync(dest, { recursive: true, force: true });
      removed++;
    }
  }
  console.log(`\n${removed} skill directories ${args['dry-run'] ? 'would be removed' : 'removed'}.`);
  return 0;
}
