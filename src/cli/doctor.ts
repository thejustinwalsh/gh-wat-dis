import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { validateConfig } from './config.ts';
import type { Config } from './config.ts';
import { MANIFEST, hashDir, skillNames, targets } from './install.ts';
import type { Manifest } from './install.ts';
import { CCCC, install as installCccc, locate as locateCccc, platformKey } from '../tools/cccc.ts';
import { CONFIG_REL, PKG, UsageError, compareVersions, errorMessage, parseArgs, readJson, repoRoot, run } from './util.ts';

const MIN_GH = '2.99.0';
const MIN_NODE = '24.0.0';

/**
 * One line of the report. A reader needs to know one thing from it: is this fine, or is there something to do.
 *   ok   nothing to do
 *   fix  something is wrong and gh-wat-dis will not work properly until it is fixed. `action` says how
 *   off  an optional feature that is not set up. `action` says how to turn it on
 * `code` names the case for the code that offers a fix, so nothing has to match on wording.
 */
export interface Check { status: 'ok' | 'fix' | 'off'; name: string; detail: string; action?: string; code?: string }

const LOGIN = ['auth', 'login', '--hostname', 'github.com', '--web'];
const LOGIN_CMD = `gh ${LOGIN.join(' ')}`;

function checkRuntime(): Check {
  const g = globalThis as { Bun?: { version: string }; Deno?: { version: { deno: string } } };
  if (g.Bun) return { status: 'ok', name: 'runtime', detail: `bun ${g.Bun.version}` };
  if (g.Deno) return { status: 'ok', name: 'runtime', detail: `deno ${g.Deno.version.deno}` };
  const v = process.versions.node;
  return compareVersions(v, MIN_NODE) >= 0
    ? { status: 'ok', name: 'runtime', detail: `node ${v}` }
    : { status: 'fix', name: 'runtime', detail: `node ${v} is too old`, action: `install Node ${MIN_NODE} or later: https://nodejs.org` };
}

function checkGh(offline: boolean): Check[] {
  const out = run('gh', ['--version']);
  if (!out) return [{ status: 'fix', name: 'GitHub CLI', detail: 'gh is not installed', action: 'install it: https://cli.github.com' }];
  const v = out.match(/gh version (\d+\.\d+\.\d+)/)?.[1] ?? '0.0.0';
  const res: Check[] = [compareVersions(v, MIN_GH) >= 0
    ? { status: 'ok', name: 'GitHub CLI', detail: `gh ${v}` }
    : { status: 'fix', name: 'GitHub CLI', detail: `gh ${v} is too old to upload diagrams`, action: `upgrade to ${MIN_GH} or later: brew upgrade gh, or https://cli.github.com` }];
  if (!offline) res.push(checkAuth());
  return res;
}

function checkAuth(): Check {
  const login = run('gh', ['api', 'user', '--jq', '.login']);
  if (!login) {
    const hasToken = Boolean(run('gh', ['auth', 'token']));
    return {
      status: 'fix', name: 'GitHub sign-in', code: 'auth-none',
      detail: hasToken ? 'the saved sign-in has expired' : 'gh is not signed in',
      action: `a person runs this in their own terminal: ${LOGIN_CMD}`,
    };
  }
  const status = spawnSync('gh', ['auth', 'status', '--hostname', 'github.com'], { encoding: 'utf8' });
  const scopes = `${status.stdout}${status.stderr}`.match(/Token scopes: (.*)/)?.[1]?.replace(/'/g, '').split(/,\s*/) ?? [];
  if (scopes.length && !scopes.includes('repo')) {
    return { status: 'fix', name: 'GitHub sign-in', code: 'auth-scope', detail: `signed in as ${login}, without permission to write to repositories`, action: 'run: gh auth refresh --scopes repo' };
  }
  return { status: 'ok', name: 'GitHub sign-in', detail: `signed in as ${login}` };
}

/**
 * Signs in through gh's own browser flow. Only runs in a terminal a person is using:
 * an agent gets the command to hand to the human instead.
 */
export async function offerLogin(checks: Check[]): Promise<boolean> {
  const auth = checks.find((c) => c.code === 'auth-none' || c.code === 'auth-scope');
  if (!auth) return false;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`\nGitHub sign-in needs a person. Ask them to run this in their own terminal, then run doctor again:\n  ${LOGIN_CMD}`);
    return false;
  }
  if (auth.code === 'auth-scope') return false;
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
      const name = `skills (${scope.project ? 'this project' : 'your user folder'})`;
      if (count('current') === names.length) {
        res.push({ status: 'ok', name, detail: `${names.length} skills installed in ${t.root}` });
      } else {
        const said = [
          count('old') ? `${count('old')} from an older version` : '',
          count('missing') ? `${count('missing')} missing` : '',
          count('edited') ? `${count('edited')} edited by hand` : '',
          count('foreign') ? `${count('foreign')} not installed by gh-wat-dis` : '',
        ].filter(Boolean).join(', ');
        // install will not overwrite a directory someone edited or one it does not own: that takes --force.
        const force = count('edited') || count('foreign') ? ' --force (it replaces the edited ones)' : '';
        res.push({ status: 'fix', name, detail: `${said}, in ${t.root}`, action: `run: npx gh-wat-dis install${scope.project ? ' --project' : ''}${force}` });
      }
    }
  }
  if (!res.length) res.push({ status: 'fix', name: 'skills', detail: 'no skills are installed', action: 'run: npx gh-wat-dis install' });
  return res;
}

type Servers = Record<string, unknown> | undefined;
const MCP = 'GitHub MCP server (optional)';

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
    return { status: 'off', name: MCP, code: 'mcp-none', detail: `not set up. The skills read GitHub through gh without it.${have}`, action: 'to turn it on: npx gh-wat-dis mcp --apply' };
  }
  const where = `set up for ${found.join(', ')}`;
  if (!wanted.size) {
    return { status: 'ok', name: MCP, detail: `${where}${helper ? ', signed in through gh' : ''}` };
  }
  const inFile = envFileVars(cwd);
  const missing = [...wanted].filter((n) => !process.env[n]);
  const fromFile = missing.filter((n) => inFile.includes(n));
  if (missing.length && fromFile.length === missing.length) {
    return { status: 'fix', name: MCP, detail: `${where}, but it cannot sign in: ${missing.join(', ')} is in ${ENV_FILE_REL} and that file is not loaded here`, action: `start the harness with the file loaded, with direnv or mise, or: set -a; . ${ENV_FILE_REL}; set +a` };
  }
  if (missing.length) {
    const reuse = present.length
      ? `run: export ${missing[0]}="$${present[0]}" (${present[0]} is already set), then restart the harness`
      : `put ${missing[0]}=<token> in ${ENV_FILE_REL} and load that file for this project, then restart the harness. For Claude Code, no token is needed: npx gh-wat-dis mcp claude`;
    return { status: 'fix', name: MCP, detail: `${where}, but it cannot sign in: ${missing.join(', ')} is not set`, action: reuse };
  }
  if (!offline) {
    for (const n of wanted) {
      if ((await tokenWorks(n)) === false) {
        return { status: 'fix', name: MCP, detail: `${where}, but GitHub rejects the token in ${n}: it has expired or was revoked`, action: `run: export ${n}="$(gh auth token)", then restart the harness` };
      }
    }
  }
  return { status: 'ok', name: MCP, detail: `${where}${offline ? '' : ', and GitHub accepts its token'}` };
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
  if (tracked) return [{ status: 'fix', name: 'token file', detail: `${ENV_FILE_REL} holds a token and git is tracking it`, action: `run: git rm --cached ${ENV_FILE_REL}. Then revoke that token on GitHub and make a new one` }];
  if (!ignored) return [{ status: 'fix', name: 'token file', detail: `${ENV_FILE_REL} holds a token and git would commit it`, action: 'add a line ".env" to .agents/gh-wat-dis/.gitignore' }];
  return [{ status: 'ok', name: 'token file', detail: `git ignores ${ENV_FILE_REL}` }];
}

function checkConfig(cwd: string): Check {
  const root = repoRoot(cwd);
  const path = join(root, CONFIG_REL);
  if (!existsSync(path)) {
    return { status: 'off', name: 'repository config (optional)', detail: 'this repository has none, so the skills ask before each use', action: 'to set it up: npx gh-wat-dis install' };
  }
  const cfg = readJson<Config>(path);
  if (!cfg) return { status: 'fix', name: 'repository config', detail: `${CONFIG_REL} is not valid JSON`, action: `correct the file, or write a new one: npx gh-wat-dis init --force` };
  const errors = validateConfig(cfg);
  if (errors.length) return { status: 'fix', name: 'repository config', detail: `${CONFIG_REL} has ${errors.length === 1 ? 'a value' : `${errors.length} values`} gh-wat-dis cannot use: ${errors.join('; ')}`, action: `correct ${errors.length === 1 ? 'it' : 'them'} in ${CONFIG_REL}` };
  const use = { always: 'agents use gh-wat-dis here without asking', ask: 'agents ask once per session before they use gh-wat-dis here', never: 'agents do not use gh-wat-dis here' }[cfg.policy.use] ?? `policy.use is ${cfg.policy.use}`;
  return { status: 'ok', name: 'repository config', detail: `${use}; ${cfg.architecture?.elements?.length ?? 0} architecture elements mapped` };
}

/** The rasterizer loaded and drew, and left the text out. It raises no error of its own for that. */
class NoFont extends Error {}
const NO_FONT_ACTION: Record<string, string> = {
  linux: 'install a sans-serif font, for example: sudo apt-get install fonts-dejavu-core',
  win32: 'install Segoe UI or Arial for all users (C:\\Windows\\Fonts)',
  darwin: 'restore Helvetica in Font Book',
};

async function checkTools(): Promise<Check[]> {
  const probes: [name: string, load: () => Promise<void>][] = [
    ['diagrams', async () => { await import('elkjs/lib/elk.bundled.js'); }],
    ['diagram previews', async () => {
      const { toPng, drawsText } = await import('../tools/raster.ts');
      toPng('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>');
      if (!drawsText()) throw new NoFont();
    }],
    ['TypeScript analysis', async () => {
      const { parse, Lang } = await import('@ast-grep/napi');
      parse(Lang.TypeScript, 'export const a = 1');
    }],
    ['Rust analysis', async () => {
      const { parse, registerDynamicLanguage } = await import('@ast-grep/napi');
      const rust = (await import('@ast-grep/lang-rust')).default;
      registerDynamicLanguage({ rust });
      parse('rust', 'pub fn a() {}');
    }],
  ];
  const res: Check[] = [];
  for (const [name, load] of probes) {
    try { await load(); res.push({ status: 'ok', name, detail: 'working' }); }
    catch (e) {
      if (e instanceof NoFont) { res.push({ status: 'fix', name, detail: 'PNG previews come out with no text, because this machine has no font the rasterizer can use. SVG output is not affected', action: NO_FONT_ACTION[process.platform] ?? NO_FONT_ACTION.linux! }); continue; }
      res.push({ status: 'fix', name, detail: `a part of ${PKG.name} did not load: ${errorMessage(e).split('\n')[0]}`, action: `install ${PKG.name} again. If it still fails, report it: ${PKG.bugs}` });
    }
  }
  return res;
}

const TOOLS_CMD = 'npx gh-wat-dis doctor --tools install';

/** Optional: complexity scores for the facts. Missing, it is a feature that is off, never a fault. */
function checkComplexity(): Check {
  const name = 'complexity facts (optional)';
  const found = locateCccc();
  if (found?.receipt) return { status: 'ok', name, detail: `cccc ${found.version}, ${found.receipt.attested ? 'download verified' : 'download checked against its pinned hash'}` };
  if (found) return { status: 'ok', name, detail: `cccc ${found.version}, the copy on your PATH` };
  if (!CCCC.assets[platformKey()]) return { status: 'ok', name, detail: `not available for ${platformKey()}. Everything else works without it` };
  return { status: 'off', name, code: 'cccc-missing', detail: 'cccc is not installed, so impact reports no complexity', action: `to turn it on: ${TOOLS_CMD}` };
}

/**
 * Offer to fetch cccc. `mode` is the --tools flag: install without asking, or skip.
 * With no terminal attached and no flag it changes nothing: the warning already names the command.
 */
export async function offerTools(checks: Check[], mode?: string): Promise<boolean> {
  if (mode === 'skip' || !checks.some((c) => c.code === 'cccc-missing')) return false;
  if (mode !== 'install') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`\nInstall cccc ${CCCC.version} for complexity facts? It is downloaded from github.com/${CCCC.repo}, checked against a pinned sha256 and its build attestation, and kept in your user cache. [Y/n] `)).trim().toLowerCase();
    rl.close();
    if (answer && answer !== 'y' && answer !== 'yes') return false;
  }
  console.log('\nInstalling cccc');
  try { installCccc((line) => console.log(`  ${line}`)); return true; } catch (e) {
    console.log(`  failed: ${errorMessage(e)}`);
    return false;
  }
}

export async function runChecks({ offline = false, cwd = process.cwd() }: { offline?: boolean; cwd?: string } = {}): Promise<Check[]> {
  return [checkRuntime(), ...checkGh(offline), ...checkSkills(cwd), await checkMcp(cwd, offline), ...checkEnvFile(cwd), checkConfig(cwd), ...(await checkTools()), checkComplexity()];
}

const LABEL = { ok: 'ok', fix: 'FIX', off: 'off' } as const;

/**
 * Prints one line for each check, and under every line that is not `ok` the one thing to do about it.
 * Returns how many need fixing.
 */
export function printChecks(checks: Check[]): number {
  const width = Math.max(...checks.map((c) => c.name.length)) + 2;
  for (const c of checks) {
    console.log(`${LABEL[c.status].padEnd(4)} ${c.name.padEnd(width)}${c.detail}`);
    if (c.action) console.log(`${' '.repeat(5 + width)}→ ${c.action}`);
  }
  const count = (s: Check['status']): number => checks.filter((c) => c.status === s).length;
  const fixes = count('fix');
  const off = count('off');
  const parts = [fixes ? `${fixes} to fix` : 'Nothing to fix', ...(off ? [`${off} optional ${off === 1 ? 'feature is' : 'features are'} off`] : []), `${count('ok')} ok`];
  console.log(`\n${parts.join(', ')}.`);
  return fixes;
}

const HELP = `Usage: npx gh-wat-dis doctor [--offline] [--json] [--no-login] [--mcp user|project|skip] [--tools install|skip]

Check the runtime, gh, the installed skills, the GitHub MCP server and the repository config.

Each line is one of three things:
  ok   nothing to do
  FIX  something is wrong. The next line, after "→", is what to do
  off  an optional feature that is not set up. The next line says how to turn it on

In a terminal, doctor offers to do three of these for you: sign gh in, set up the GitHub MCP server,
and install the optional cccc tool. Everything else it prints as a command for you to run.
Exits non-zero when there is something to fix.

  --offline        skip the checks that call GitHub
  --json           print the checks as JSON (status, name, detail, action) and offer nothing
  --no-login       do not offer to run gh auth login
  --mcp <scope>    where to write the GitHub MCP server config when none is found: user, project or skip
  --tools <mode>   optional analysis tools (cccc, for complexity facts): install without asking, or skip

Optional tools are fetched from their own releases into your user cache, checked against a pinned sha256
and the release's build attestation. A missing optional tool is \"off\", never something to fix.
`;

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['offline', 'json', 'no-login', 'help'], strings: ['mcp', 'tools'], aliases: { '-h': '--help' } });
  if (args.tools && !['install', 'skip'].includes(args.tools)) throw new UsageError('--tools must be install or skip');
  if (args.help) { process.stdout.write(HELP); return 0; }
  let checks = await runChecks({ offline: args.offline });
  if (args.json) {
    console.log(JSON.stringify(checks, null, 2));
    return checks.some((c) => c.status === 'fix') ? 1 : 0;
  }
  let fails = printChecks(checks);
  let again = !args['no-login'] && await offerLogin(checks);
  if (checks.some((c) => c.code === 'mcp-none')) {
    const { offerMcpSetup } = await import('./mcp-apply.ts');
    again = (await offerMcpSetup({ scope: args.mcp as 'user' | 'project' | 'skip' | undefined })).some((r) => r.action === 'added') || again;
  }
  again = await offerTools(checks, args.tools) || again;
  if (again) {
    console.log('\nChecking again');
    checks = await runChecks({ offline: args.offline });
    fails = printChecks(checks);
  }
  return fails ? 1 : 0;
}
