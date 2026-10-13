import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { validateConfig } from './config.ts';
import type { Config } from './config.ts';
import { MANIFEST, hashDir, skillNames, targets } from './install.ts';
import type { Manifest } from './install.ts';
import { CONFIG_REL, PKG, compareVersions, errorMessage, parseArgs, readJson, repoRoot, run } from './util.ts';

const MIN_GH = '2.99.0';
const MIN_NODE = '24.0.0';

export interface Check { status: 'ok' | 'warn' | 'FAIL'; name: string; detail: string }

function checkRuntime(): Check {
  const g = globalThis as { Bun?: { version: string }; Deno?: { version: { deno: string } } };
  if (g.Bun) return { status: 'ok', name: 'runtime', detail: `bun ${g.Bun.version}` };
  if (g.Deno) return { status: 'ok', name: 'runtime', detail: `deno ${g.Deno.version.deno}` };
  const v = process.versions.node;
  return compareVersions(v, MIN_NODE) >= 0
    ? { status: 'ok', name: 'runtime', detail: `node ${v}` }
    : { status: 'FAIL', name: 'runtime', detail: `node ${v}. Needs ${MIN_NODE} or later.` };
}

function checkGh(offline: boolean): Check[] {
  const out = run('gh', ['--version']);
  if (!out) return [{ status: 'FAIL', name: 'gh', detail: 'GitHub CLI not found. Install it: https://cli.github.com' }];
  const v = out.match(/gh version (\d+\.\d+\.\d+)/)?.[1] ?? '0.0.0';
  const res: Check[] = [compareVersions(v, MIN_GH) >= 0
    ? { status: 'ok', name: 'gh', detail: `${v}, --attach available` }
    : { status: 'FAIL', name: 'gh', detail: `${v}. Attachments need ${MIN_GH} or later. Upgrade: brew upgrade gh, or https://cli.github.com` }];
  if (!offline) {
    const login = run('gh', ['api', 'user', '--jq', '.login']);
    res.push(login
      ? { status: 'ok', name: 'gh auth', detail: `signed in as ${login}` }
      : { status: 'FAIL', name: 'gh auth', detail: 'not signed in, or the token is no longer valid. Run in your own terminal: gh auth login' });
  }
  return res;
}

function checkSkills(cwd: string): Check[] {
  const names = skillNames();
  const res: Check[] = [];
  for (const scope of [{ project: false, label: 'global' }, { project: true, label: 'project' }]) {
    for (const t of targets({ project: scope.project, clients: ['agents', 'claude'], cwd })) {
      const states = names.map((n) => {
        const dir = join(t.root, n);
        if (!existsSync(dir)) return 'missing';
        const m = readJson<Manifest>(join(dir, MANIFEST));
        if (!m) return 'foreign';
        if (hashDir(dir) !== m.hash) return 'edited';
        return m.version === PKG.version ? 'current' : 'old';
      });
      const count = (s: string): number => states.filter((x) => x === s).length;
      if (count('missing') === names.length) continue;
      const name = `skills ${scope.label} ${t.client}`;
      if (count('current') === names.length) {
        res.push({ status: 'ok', name, detail: `${names.length} skills, ${PKG.version}, ${t.root}` });
      } else {
        res.push({
          status: count('missing') || count('foreign') ? 'FAIL' : 'warn', name,
          detail: `${count('current')} current, ${count('old')} old, ${count('edited')} edited, ${count('missing')} missing, ${count('foreign')} not ours in ${t.root}. Run: npx gh-wat-dis install${scope.project ? ' --project' : ''}`,
        });
      }
    }
  }
  if (!res.length) res.push({ status: 'FAIL', name: 'skills', detail: 'not installed. Run: npx gh-wat-dis install' });
  return res;
}

type Servers = Record<string, unknown> | undefined;

function checkMcp(cwd: string): Check {
  const home = homedir();
  const key = (k: string) => (p: string): Servers => readJson<Record<string, Servers>>(p)?.[k];
  const places: [label: string, path: string, get: (path: string) => Servers][] = [
    ['Claude Code (user)', join(home, '.claude.json'), key('mcpServers')],
    ['Claude Code (project)', join(cwd, '.mcp.json'), key('mcpServers')],
    ['Codex', join(home, '.codex/config.toml'), (p) => (/^\[mcp_servers\.github\]/m.test(readFileSync(p, 'utf8')) ? { github: {} } : {})],
    ['Cursor', join(home, '.cursor/mcp.json'), key('mcpServers')],
    ['Cursor (project)', join(cwd, '.cursor/mcp.json'), key('mcpServers')],
    ['Gemini CLI', join(home, '.gemini/settings.json'), key('mcpServers')],
    ['OpenCode', join(home, '.config/opencode/opencode.json'), key('mcp')],
    ['VS Code (project)', join(cwd, '.vscode/mcp.json'), key('servers')],
  ];
  const found: string[] = [];
  for (const [label, path, get] of places) {
    if (!existsSync(path)) continue;
    try {
      if (Object.keys(get(path) ?? {}).some((k) => /github/i.test(k))) found.push(label);
    } catch { /* an unreadable harness config is not ours to report */ }
  }
  return found.length
    ? { status: 'ok', name: 'github mcp', detail: `configured for ${found.join(', ')}` }
    : { status: 'warn', name: 'github mcp', detail: 'no GitHub MCP server found in a known config. Optional: skills read through gh without it. Set up: npx gh-wat-dis mcp <client>' };
}

function checkConfig(cwd: string): Check {
  const root = repoRoot(cwd);
  const path = join(root, CONFIG_REL);
  if (!existsSync(path)) {
    return { status: 'warn', name: 'repo config', detail: `no ${CONFIG_REL} in ${root}. Skills will ask before use. Create it: npx gh-wat-dis init` };
  }
  const cfg = readJson<Config>(path);
  if (!cfg) return { status: 'FAIL', name: 'repo config', detail: `${CONFIG_REL} is not valid JSON` };
  const errors = validateConfig(cfg);
  if (errors.length) return { status: 'FAIL', name: 'repo config', detail: `${CONFIG_REL}: ${errors.join('; ')}` };
  return { status: 'ok', name: 'repo config', detail: `policy.use=${cfg.policy.use}, ${cfg.architecture?.elements?.length ?? 0} architecture elements` };
}

async function checkTools(): Promise<Check[]> {
  const probes: [name: string, load: () => Promise<void>][] = [
    ['diagram layout', async () => { await import('elkjs/lib/elk.bundled.js'); }],
    ['facts typescript', async () => {
      const { parse, Lang } = await import('@ast-grep/napi');
      parse(Lang.TypeScript, 'export const a = 1');
    }],
    ['facts rust', async () => {
      const { parse, registerDynamicLanguage } = await import('@ast-grep/napi');
      const rust = (await import('@ast-grep/lang-rust')).default;
      registerDynamicLanguage({ rust });
      parse('rust', 'pub fn a() {}');
    }],
  ];
  const res: Check[] = [];
  for (const [name, load] of probes) {
    try { await load(); res.push({ status: 'ok', name, detail: 'ready' }); }
    catch (e) { res.push({ status: 'FAIL', name, detail: `cannot load: ${errorMessage(e).split('\n')[0]}` }); }
  }
  return res;
}

export async function runChecks({ offline = false, cwd = process.cwd() }: { offline?: boolean; cwd?: string } = {}): Promise<Check[]> {
  return [checkRuntime(), ...checkGh(offline), ...checkSkills(cwd), checkMcp(cwd), checkConfig(cwd), ...(await checkTools())];
}

export function printChecks(checks: Check[]): number {
  for (const c of checks) console.log(`${c.status.padEnd(4)} ${c.name.padEnd(22)} ${c.detail}`);
  const fails = checks.filter((c) => c.status === 'FAIL').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  console.log(`\n${fails} failed, ${warns} warnings, ${checks.length - fails - warns} ok.`);
  return fails;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['offline', 'json'] });
  const checks = await runChecks({ offline: args.offline });
  if (args.json) {
    console.log(JSON.stringify(checks, null, 2));
    return checks.some((c) => c.status === 'FAIL') ? 1 : 0;
  }
  return printChecks(checks) ? 1 : 0;
}
