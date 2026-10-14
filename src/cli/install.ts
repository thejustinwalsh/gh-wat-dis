import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { CONFIG_REL, PKG, PKG_ROOT, UsageError, parseArgs, readJson, repoRoot } from './util.ts';

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

/** Where this package keeps the skill it ships under that name. */
export const skillSource = (name: string): string => join(SKILLS_SRC, name);

export function skillNames(): string[] {
  return readdirSync(SKILLS_SRC, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(SKILLS_SRC, d.name, 'SKILL.md')))
    .map((d) => d.name)
    .sort();
}

/** One skill as its own file describes it. `does` is what it does; `when` is the part that says when an agent uses it. */
export interface SkillInfo { name: string; does: string; when: string }

/** The shipped skills with the description from each SKILL.md, the entry skill first. */
export function skillList(): SkillInfo[] {
  return skillNames().map((name): SkillInfo => {
    const text = readFileSync(join(SKILLS_SRC, name, 'SKILL.md'), 'utf8');
    const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? '';
    const cut = description.search(/ Use (?:when|before)\b/);
    return { name, does: (cut < 0 ? description : description.slice(0, cut)).trim(), when: cut < 0 ? '' : description.slice(cut).trim() };
  }).sort((a, b) => Number(b.name === 'wat') - Number(a.name === 'wat') || a.name.localeCompare(b.name));
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

const INSTALL_HELP = `Usage: npx gh-wat-dis install [--project] [--client <names>] [--mcp user|project|skip] [--no-config] [--dry-run] [--force]

Set up gh-wat-dis in one step: copy the wat skills to where each agent harness looks, write this
repository's config when it has none, then run the doctor checks.

  --project, -p        install into this repository (default: your user directory)
  --client, -c <names> comma-separated harnesses, or "all" (default all): ${CLIENT_NAMES.join(', ')}
  --mcp <scope>        where to write the GitHub MCP server config when none is found: user, project or skip
  --no-config          do not write .agents/gh-wat-dis/config.json for this repository
  --dry-run, -n        print what would be written and change nothing
  --force, -f          replace skill directories this package did not write

The config is written only in a git repository that has none. An existing config is never changed:
"npx gh-wat-dis init --force" writes a fresh one.
`;

const UNINSTALL_HELP = `Usage: npx gh-wat-dis uninstall [--project] [--client <names>] [--dry-run]

Remove the skill directories this package installed. Other directories are left alone.

  --project, -p        remove from this repository (default: your user directory)
  --client, -c <names> comma-separated harnesses, or "all" (default all): ${CLIENT_NAMES.join(', ')}
  --dry-run, -n        print what would be removed and change nothing
`;

export async function install(argv: string[]): Promise<number> {
  const args = parseArgs(argv, {
    booleans: ['project', 'dry-run', 'force', 'help', 'no-config'], strings: ['client', 'mcp'],
    aliases: { '-n': '--dry-run', '-f': '--force', '-c': '--client', '-p': '--project', '-h': '--help' },
  });
  if (args.help) { process.stdout.write(INSTALL_HELP); return 0; }
  if (args.mcp && !['user', 'project', 'skip'].includes(args.mcp)) throw new UsageError('--mcp must be user, project or skip');
  const steps = plan({ project: args.project, clients: parseClients(args.client), force: args.force });
  for (const s of steps) console.log(`${s.action.padEnd(8)} ${s.dest}${s.note ? `  (${s.note})` : ''}`);
  // The skills are for this machine, the config is for this repository. One command sets up both.
  const root = repoRoot();
  const needsConfig = !args['no-config'] && existsSync(join(root, '.git')) && !existsSync(join(root, CONFIG_REL));
  if (args['dry-run']) {
    if (needsConfig) console.log(`write    ${join(root, CONFIG_REL)}`);
    console.log('\nDry run. Nothing changed.');
    return 0;
  }
  steps.forEach(apply);
  const count = (...a: Action[]): number => steps.filter((s) => a.includes(s.action)).length;
  const changed = count('install', 'update', 'replace');
  console.log(`\n${changed} skill directories written, ${count('current')} current, ${count('skip')} skipped.`);
  if (count('skip')) console.log('Skipped directories were not touched. Run again with --force to replace them.');
  if (changed) console.log('Restart your agent harness so it loads the skills.');
  if (needsConfig) {
    console.log('\nRepository config');
    await (await import('./init.ts')).main([]);
    console.log('Review it with the person, then commit it.');
  }

  console.log('\nChecks');
  const { offerLogin, printChecks, runChecks } = await import('./doctor.ts');
  let checks = await runChecks();
  let fails = printChecks(checks);
  const noServer = checks.some((c) => c.code === 'mcp-none');
  let again = await offerLogin(checks);
  if (noServer) {
    const { offerMcpSetup } = await import('./mcp-apply.ts');
    again = (await offerMcpSetup({ scope: args.mcp as 'user' | 'project' | 'skip' | undefined })).some((r) => r.action === 'added') || again;
  }
  if (again) {
    console.log('\nChecking again');
    checks = await runChecks();
    fails = printChecks(checks);
  }
  return count('skip') || fails ? 1 : 0;
}

export async function uninstall(argv: string[]): Promise<number> {
  const args = parseArgs(argv, {
    booleans: ['project', 'dry-run', 'help'], strings: ['client'],
    aliases: { '-n': '--dry-run', '-c': '--client', '-p': '--project', '-h': '--help' },
  });
  if (args.help) { process.stdout.write(UNINSTALL_HELP); return 0; }
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
