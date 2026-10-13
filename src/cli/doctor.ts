import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { validateConfig } from './config.ts';
import type { Config } from './config.ts';
import { MANIFEST, hashDir, skillNames, targets } from './install.ts';
import type { Manifest } from './install.ts';
import { CONFIG_REL, PKG, compareVersions, errorMessage, parseArgs, readJson, repoRoot, run } from './util.ts';

const MIN_GH = '2.99.0';
const MIN_NODE = '24.0.0';

export interface Check { status: 'ok' | 'warn' | 'FAIL'; name: string; detail: string }

const LOGIN = ['auth', 'login', '--hostname', 'github.com', '--web'];
const LOGIN_CMD = `gh ${LOGIN.join(' ')}`;

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
  if (!offline) res.push(checkAuth());
  return res;
}

function checkAuth(): Check {
  const login = run('gh', ['api', 'user', '--jq', '.login']);
  if (!login) {
    const hasToken = Boolean(run('gh', ['auth', 'token']));
    return {
      status: 'FAIL', name: 'gh auth',
      detail: `${hasToken ? 'the saved token is no longer valid' : 'not signed in'}. Sign in: ${LOGIN_CMD}`,
    };
  }
  const status = spawnSync('gh', ['auth', 'status', '--hostname', 'github.com'], { encoding: 'utf8' });
  const scopes = `${status.stdout}${status.stderr}`.match(/Token scopes: (.*)/)?.[1]?.replace(/'/g, '').split(/,\s*/) ?? [];
  if (scopes.length && !scopes.includes('repo')) {
    return { status: 'FAIL', name: 'gh auth', detail: `signed in as ${login}, but the token lacks the "repo" scope. Run: gh auth refresh --scopes repo` };
  }
  return { status: 'ok', name: 'gh auth', detail: `signed in as ${login}` };
}

/**
 * Signs in through gh's own browser flow. Only runs in a terminal a person is using:
 * an agent gets the command to hand to the human instead.
 */
export async function offerLogin(checks: Check[]): Promise<boolean> {
  const auth = checks.find((c) => c.name === 'gh auth' && c.status === 'FAIL');
  if (!auth) return false;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`\nGitHub sign-in needs a person. Ask them to run this in their own terminal, then run doctor again:\n  ${LOGIN_CMD}`);
    return false;
  }
  if (auth.detail.includes('scope')) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('\nGitHub CLI is not signed in. Sign in now through your browser? [Y/n] ')).trim().toLowerCase();
  rl.close();
  if (answer && answer !== 'y' && answer !== 'yes') return false;
  return spawnSync('gh', LOGIN, { stdio: 'inherit' }).status === 0;
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

const TOKEN_VARS = ['GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_MCP_PAT', 'GITHUB_PAT_TOKEN', 'GITHUB_PAT', 'GITHUB_TOKEN', 'GH_TOKEN'];

/** Names of the environment variables a GitHub server entry reads its token from. Never the values. */
function tokenVars(entry: string): string[] {
  const names = [...entry.matchAll(/\$\{(?:env:)?([A-Z][A-Z0-9_]*)\}|\{env:([A-Z][A-Z0-9_]*)\}|\$([A-Z][A-Z0-9_]*)|bearer_token_env_var\s*=\s*"([A-Z][A-Z0-9_]*)"/g)]
    .map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]!);
  return [...new Set(names)].filter((n) => /TOKEN|PAT|KEY/.test(n));
}

async function tokenWorks(name: string): Promise<boolean | null> {
  try {
    const res = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${process.env[name]}`, 'User-Agent': 'gh-wat-dis-doctor' } });
    return res.status === 200 ? true : res.status === 401 ? false : null;
  } catch { return null; }
}

async function checkMcp(cwd: string, offline: boolean): Promise<Check> {
  const home = homedir();
  const json = (k: string) => (text: string): string | undefined => {
    const servers = (JSON.parse(text) as Record<string, Servers>)[k] ?? {};
    const key = Object.keys(servers).find((n) => /github/i.test(n));
    return key ? JSON.stringify(servers[key]) : undefined;
  };
  const toml = (text: string): string | undefined => text.match(/^\[mcp_servers\.github\][^[]*/m)?.[0];
  const places: [label: string, path: string, entry: (text: string) => string | undefined][] = [
    ['Claude Code (user)', join(home, '.claude.json'), json('mcpServers')],
    ['Claude Code (project)', join(cwd, '.mcp.json'), json('mcpServers')],
    ['Codex', join(home, '.codex/config.toml'), toml],
    ['Cursor', join(home, '.cursor/mcp.json'), json('mcpServers')],
    ['Cursor (project)', join(cwd, '.cursor/mcp.json'), json('mcpServers')],
    ['Gemini CLI', join(home, '.gemini/settings.json'), json('mcpServers')],
    ['OpenCode', join(home, '.config/opencode/opencode.json'), json('mcp')],
    ['VS Code (project)', join(cwd, '.vscode/mcp.json'), json('servers')],
  ];
  const found: string[] = [];
  const wanted = new Set<string>();
  let helper = false;
  for (const [label, path, entry] of places) {
    if (!existsSync(path)) continue;
    try {
      const e = entry(readFileSync(path, 'utf8'));
      if (e === undefined) continue;
      found.push(label);
      if (e.includes('headersHelper')) helper = true;
      else for (const v of tokenVars(e)) wanted.add(v);
    } catch { /* an unreadable harness config is not ours to report */ }
  }
  const present = TOKEN_VARS.filter((n) => process.env[n]);
  if (!found.length) {
    const have = present.length ? ` ${present[0]} is already set in this environment, so no new token is needed.` : '';
    return { status: 'warn', name: 'github mcp', detail: `no GitHub MCP server found in a known config. Optional: skills read through gh without it.${have} Set up: npx gh-wat-dis mcp <client>` };
  }
  const where = `configured for ${found.join(', ')}`;
  if (!wanted.size) {
    return { status: 'ok', name: 'github mcp', detail: helper
      ? `${where}. No token is stored: a headers helper reads it from the gh login at each connect.`
      : `${where}. The config names no token variable (the harness signs in itself).` };
  }
  const inFile = envFileVars(cwd);
  const missing = [...wanted].filter((n) => !process.env[n]);
  const fromFile = missing.filter((n) => inFile.includes(n));
  if (missing.length && fromFile.length === missing.length) {
    return { status: 'warn', name: 'github mcp', detail: `${where}. ${missing.join(', ')} is in ${ENV_FILE_REL} but not in this environment. Start the harness with that file loaded (direnv, mise, or: set -a; . ${ENV_FILE_REL}; set +a).` };
  }
  if (missing.length) {
    const reuse = present.length
      ? `${present[0]} is set: point the config at it, or run: export ${missing[0]}="$${present[0]}"`
      : `put ${missing[0]}=<token> in ${ENV_FILE_REL} and load it for this project, or for Claude Code use the headers helper from: npx gh-wat-dis mcp claude`;
    return { status: 'warn', name: 'github mcp', detail: `${where}, but ${missing.join(', ')} is not set in this environment. ${reuse}. Then restart the harness.` };
  }
  if (!offline) {
    for (const n of wanted) {
      if ((await tokenWorks(n)) === false) {
        return { status: 'FAIL', name: 'github mcp', detail: `${where}. ${n} is set, but GitHub rejects it (expired or revoked). Refresh it: export ${n}="$(gh auth token)"` };
      }
    }
  }
  return { status: 'ok', name: 'github mcp', detail: `${where}. ${[...wanted].join(', ')} is set${offline ? '' : ' and GitHub accepts it'}.` };
}

const ENV_FILE_REL = '.agents/gh-wat-dis/.env';

/** Variable names defined in the project's token file. Never the values. */
function envFileVars(cwd: string): string[] {
  const path = join(repoRoot(cwd), ENV_FILE_REL);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').map((l) => l.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*\S/)?.[1]).filter((n): n is string => Boolean(n));
}

/** A token file that git would commit is the one failure here that leaks a secret. */
function checkEnvFile(cwd: string): Check[] {
  const root = repoRoot(cwd);
  if (!existsSync(join(root, ENV_FILE_REL))) return [];
  const ignored = spawnSync('git', ['check-ignore', '-q', ENV_FILE_REL], { cwd: root }).status === 0;
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', ENV_FILE_REL], { cwd: root, stdio: 'ignore' }).status === 0;
  if (tracked) return [{ status: 'FAIL', name: 'token file', detail: `${ENV_FILE_REL} is tracked by git. Remove it from the repository (git rm --cached ${ENV_FILE_REL}), then revoke the token and make a new one.` }];
  if (!ignored) return [{ status: 'FAIL', name: 'token file', detail: `${ENV_FILE_REL} is not git-ignored. Add ".env" to .agents/gh-wat-dis/.gitignore before you commit.` }];
  return [{ status: 'ok', name: 'token file', detail: `${ENV_FILE_REL} is git-ignored` }];
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
  return [checkRuntime(), ...checkGh(offline), ...checkSkills(cwd), await checkMcp(cwd, offline), ...checkEnvFile(cwd), checkConfig(cwd), ...(await checkTools())];
}

export function printChecks(checks: Check[]): number {
  for (const c of checks) console.log(`${c.status.padEnd(4)} ${c.name.padEnd(22)} ${c.detail}`);
  const fails = checks.filter((c) => c.status === 'FAIL').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  console.log(`\n${fails} failed, ${warns} warnings, ${checks.length - fails - warns} ok.`);
  return fails;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['offline', 'json', 'no-login'], strings: ['mcp'] });
  let checks = await runChecks({ offline: args.offline });
  if (args.json) {
    console.log(JSON.stringify(checks, null, 2));
    return checks.some((c) => c.status === 'FAIL') ? 1 : 0;
  }
  let fails = printChecks(checks);
  let again = !args['no-login'] && await offerLogin(checks);
  if (checks.some((c) => c.name === 'github mcp' && c.status === 'warn' && c.detail.startsWith('no GitHub MCP server'))) {
    const { offerMcpSetup } = await import('./mcp-apply.ts');
    again = (await offerMcpSetup({ scope: args.mcp as 'user' | 'project' | 'skip' | undefined })).some((r) => r.action === 'added') || again;
  }
  if (again) {
    console.log('\nChecking again');
    checks = await runChecks({ offline: args.offline });
    fails = printChecks(checks);
  }
  return fails ? 1 : 0;
}
