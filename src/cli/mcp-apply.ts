import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseJsonc, repoRoot, run } from './util.ts';

const URL = 'https://api.githubcopilot.com/mcp/';
const ENV = 'GITHUB_PERSONAL_ACCESS_TOKEN';
const TOOLSETS = 'default,labels';
/** Prints the Authorization header from the gh login. Claude Code runs it at each connect, so no token is stored. */
export const GH_HEADERS_HELPER = 'echo "{\\"Authorization\\":\\"Bearer $(gh auth token)\\"}"';

export const SCOPES = ['user', 'project'] as const;
export type Scope = (typeof SCOPES)[number];
export type Applied = { client: string; label: string; action: 'added' | 'exists' | 'skipped' | 'failed'; where: string; detail?: string };

const extra = (ro: boolean): Record<string, string> => ({ 'X-MCP-Toolsets': TOOLSETS, ...(ro ? { 'X-MCP-Readonly': 'true' } : {}) });
const withToken = (ref: string, ro: boolean): Record<string, string> => ({ Authorization: `Bearer ${ref}`, ...extra(ro) });

interface JsonTarget { kind: 'json'; user: string; project?: string; key: string; entry: (ro: boolean) => unknown; /** The harness also reads the same file with this extension, and merges the two. */ twin?: string }
interface TomlTarget { kind: 'toml'; user: string; project?: string; block: (ro: boolean) => string; /** What a person must know about the project-level file. */ projectNote?: string }
interface CliTarget { kind: 'claude'; project: string; entry: (ro: boolean) => unknown }
interface Target { label: string; needsEnv: boolean; detect: (home: string) => boolean; write: JsonTarget | TomlTarget | CliTarget }

const onPath = (bin: string): boolean => run('sh', ['-c', `command -v ${bin}`]) !== null;

/** Harnesses whose GitHub MCP entry this tool can write. Paths are relative to the home or the project root. */
export const TARGETS: Record<string, Target> = {
  claude: {
    label: 'Claude Code', needsEnv: false,
    detect: (home) => existsSync(join(home, '.claude')) || onPath('claude'),
    write: { kind: 'claude', project: '.mcp.json', entry: (ro) => ({ type: 'http', url: URL, headersHelper: GH_HEADERS_HELPER, headers: extra(ro) }) },
  },
  codex: {
    label: 'Codex CLI', needsEnv: true,
    detect: (home) => existsSync(join(home, '.codex')) || onPath('codex'),
    write: {
      kind: 'toml', user: '.codex/config.toml', project: '.codex/config.toml',
      block: (ro) => `[mcp_servers.github]\nurl = "${URL}"\nbearer_token_env_var = "${ENV}"\nhttp_headers = { "X-MCP-Toolsets" = "${TOOLSETS}"${ro ? ', "X-MCP-Readonly" = "true"' : ''} }\n`,
      projectNote: 'Codex reads this file only in a project it trusts',
    },
  },
  cursor: {
    label: 'Cursor', needsEnv: true,
    detect: (home) => existsSync(join(home, '.cursor')),
    write: { kind: 'json', user: '.cursor/mcp.json', project: '.cursor/mcp.json', key: 'mcpServers', entry: (ro) => ({ url: URL, headers: withToken(`\${env:${ENV}}`, ro) }) },
  },
  gemini: {
    label: 'Gemini CLI', needsEnv: true,
    detect: (home) => existsSync(join(home, '.gemini')) || onPath('gemini'),
    write: { kind: 'json', user: '.gemini/settings.json', project: '.gemini/settings.json', key: 'mcpServers', entry: (ro) => ({ httpUrl: URL, headers: withToken(`$${ENV}`, ro) }) },
  },
  opencode: {
    label: 'OpenCode', needsEnv: true,
    detect: (home) => existsSync(join(home, '.config/opencode')) || onPath('opencode'),
    write: {
      kind: 'json', user: '.config/opencode/opencode.json', project: 'opencode.json', key: 'mcp', twin: '.jsonc',
      entry: (ro) => ({ type: 'remote', url: URL, enabled: true, oauth: false, headers: withToken(`{env:${ENV}}`, ro) }),
    },
  },
};

export const detectClients = (home: string = homedir()): string[] => Object.keys(TARGETS).filter((c) => TARGETS[c]!.detect(home));

const hasGithub = (servers: unknown): boolean => Object.keys((servers ?? {}) as Record<string, unknown>).some((k) => /github/i.test(k));

/**
 * Adds a key to a JSON config and keeps everything else. Refuses a file it cannot parse, such as JSON with comments.
 * `twin` is a second file the harness merges with this one: an entry there counts as already set up.
 */
function mergeJson(path: string, key: string, name: string, value: unknown, twin?: string): 'added' | 'exists' {
  if (twin && existsSync(twin) && hasGithub(parseJsonc<Record<string, unknown>>(readFileSync(twin, 'utf8'))[key])) return 'exists';
  let doc: Record<string, unknown> = {};
  if (existsSync(path)) {
    const text = readFileSync(path, 'utf8');
    if (text.trim()) doc = JSON.parse(text) as Record<string, unknown>;
  }
  const servers = (doc[key] ?? {}) as Record<string, unknown>;
  if (hasGithub(servers)) return 'exists';
  doc[key] = { ...servers, [name]: value };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
  return 'added';
}

function mergeToml(path: string, block: string): 'added' | 'exists' {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (/^\[mcp_servers\.github\]/m.test(text)) return 'exists';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}${block}`);
  return 'added';
}

export interface ApplyOptions { scope: Scope; readonly?: boolean; home?: string; cwd?: string; dryRun?: boolean }

/** Writes the GitHub MCP server entry for one harness. It never replaces an entry that is already there. */
export function applyClient(client: string, { scope, readonly = true, home = homedir(), cwd = process.cwd(), dryRun = false }: ApplyOptions): Applied {
  const t = TARGETS[client];
  if (!t) return { client, label: client, action: 'skipped', where: '', detail: 'this tool cannot write the config for this harness. Run: npx gh-wat-dis mcp ' + client };
  const base = scope === 'user' ? home : repoRoot(cwd);
  const w = t.write;
  try {
    if (w.kind === 'claude') {
      if (scope === 'project') {
        const path = join(base, w.project);
        if (dryRun) return { client, label: t.label, action: 'added', where: path };
        return { client, label: t.label, action: mergeJson(path, 'mcpServers', 'github', w.entry(readonly)), where: path };
      }
      const where = '~/.claude.json (user scope)';
      if (!onPath('claude')) return { client, label: t.label, action: 'skipped', where, detail: 'the claude command is not on PATH' };
      if (/^github:/m.test(run('claude', ['mcp', 'get', 'github']) ?? '')) return { client, label: t.label, action: 'exists', where };
      if (dryRun) return { client, label: t.label, action: 'added', where };
      const res = spawnSync('claude', ['mcp', 'add-json', 'github', '--scope', 'user', JSON.stringify(w.entry(readonly))], { encoding: 'utf8' });
      return res.status === 0
        ? { client, label: t.label, action: 'added', where }
        : { client, label: t.label, action: 'failed', where, detail: (res.stderr || res.stdout).trim().split('\n')[0] };
    }
    const rel = scope === 'user' ? w.user : w.project;
    if (!rel) return { client, label: t.label, action: 'skipped', where: '', detail: `${t.label} has no ${scope}-level config` };
    const path = join(base, rel);
    if (dryRun) return { client, label: t.label, action: 'added', where: path };
    const action = w.kind === 'json'
      ? mergeJson(path, w.key, 'github', w.entry(readonly), w.twin && path.replace(/\.json$/, w.twin))
      : mergeToml(path, w.block(readonly));
    const note = action === 'added' && scope === 'project' && w.kind === 'toml' ? w.projectNote : undefined;
    return { client, label: t.label, action, where: path, ...(note ? { detail: note } : {}) };
  } catch (e) {
    return { client, label: t.label, action: 'failed', where: '', detail: `could not update the config (${e instanceof Error ? e.message.split('\n')[0] : e}). Add it by hand: npx gh-wat-dis mcp ${client}` };
  }
}

export function printApplied(results: Applied[]): void {
  for (const r of results) console.log(`${r.action.padEnd(8)} ${r.label.padEnd(12)} ${r.where}${r.detail ? `  (${r.detail})` : ''}`);
  const envClients = results.filter((r) => r.action === 'added' && TARGETS[r.client]?.needsEnv).map((r) => r.label);
  if (envClients.length) {
    console.log(`\n${envClients.join(', ')} read${envClients.length === 1 ? 's' : ''} the token from ${ENV}. Put ${ENV}=<token> in .agents/gh-wat-dis/.env and load it for the project, not in a global shell profile.`);
  }
  if (results.some((r) => r.action === 'added')) console.log('Restart each harness so it loads the server.');
}

/**
 * Asks a person which harnesses to set up and at which level, then writes the entries.
 * With no terminal attached it changes nothing and says what to run.
 */
export async function offerMcpSetup({ scope, cwd = process.cwd() }: { scope?: Scope | 'skip'; cwd?: string } = {}): Promise<Applied[]> {
  if (scope === 'skip') return [];
  const clients = detectClients();
  if (!clients.length) return [];
  const names = clients.map((c) => TARGETS[c]!.label).join(', ');
  let chosen = scope;
  if (!chosen) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.log(`\nGitHub MCP server: found ${names}. Ask the person which level they want, then run:\n  npx gh-wat-dis mcp --apply --scope user      (every repository, recommended)\n  npx gh-wat-dis mcp --apply --scope project   (this repository only)`);
      return [];
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`\nSet up the GitHub MCP server for ${names}?\n  [u] user level: every repository (recommended)\n  [p] project level: this repository only\n  [s] skip\n> `)).trim().toLowerCase();
    rl.close();
    chosen = answer === '' || answer.startsWith('u') ? 'user' : answer.startsWith('p') ? 'project' : undefined;
    if (!chosen) return [];
  }
  const results = clients.map((c) => applyClient(c, { scope: chosen, cwd }));
  printApplied(results);
  return results;
}
