import { GH_HEADERS_HELPER, SCOPES, TARGETS, applyClient, detectClients, printApplied } from './mcp-apply.ts';
import type { Scope } from './mcp-apply.ts';
import { UsageError, parseArgs } from './util.ts';

interface Snippet {
  target: string;
  lang: 'bash' | 'toml' | 'json';
  snippet: string;
  noToken?: boolean;
  /** Where the same entry goes when a team wants it in one repository. */
  project?: string;
  /** How this harness gets the token, when it is not an environment variable. */
  note?: string;
  /** A link that opens the harness on its own "add this MCP server" screen. Only some harnesses have one. */
  link?: string;
}

const URL = 'https://api.githubcopilot.com/mcp/';
const ENV = 'GITHUB_PERSONAL_ACCESS_TOKEN';
const TOOLSETS = 'default,labels';
const ENV_FILE = '.agents/gh-wat-dis/.env';

const json = (v: unknown): string => JSON.stringify(v, null, 2);
const staticHeaders = (readonly: boolean): Record<string, string> => ({ 'X-MCP-Toolsets': TOOLSETS, ...(readonly ? { 'X-MCP-Readonly': 'true' } : {}) });
const headers = (token: string, readonly: boolean): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  'X-MCP-Toolsets': TOOLSETS,
  ...(readonly ? { 'X-MCP-Readonly': 'true' } : {}),
});

export const CLIENTS: Record<string, (readonly: boolean) => Snippet> = {
  claude: (ro) => ({
    target: 'Claude Code, user scope (~/.claude.json). Works in every project, with no approval prompt in each one.',
    lang: 'bash',
    snippet: `claude mcp add-json github --scope user '${JSON.stringify({ type: 'http', url: URL, headersHelper: GH_HEADERS_HELPER, headers: staticHeaders(ro) })}'`,
    noToken: true,
    note: 'Token: none stored. Claude Code runs the helper at each connect and reads the token from your gh login.',
    project: 'For one repository, put the same object under "mcpServers" in .mcp.json. Each person then approves the server and the trust dialog once.',
  }),
  codex: (ro) => ({
    target: '~/.codex/config.toml (user level)',
    lang: 'toml',
    snippet: `[mcp_servers.github]\nurl = "${URL}"\nbearer_token_env_var = "${ENV}"\nhttp_headers = { "X-MCP-Toolsets" = "${TOOLSETS}"${ro ? ', "X-MCP-Readonly" = "true"' : ''} }`,
  }),
  cursor: (ro) => ({
    target: '~/.cursor/mcp.json (user level)',
    project: 'For one repository: .cursor/mcp.json.',
    lang: 'json',
    snippet: json({ mcpServers: { github: { url: URL, headers: headers(`\${env:${ENV}}`, ro) } } }),
    link: `https://cursor.com/en/install-mcp?name=github&config=${encodeURIComponent(Buffer.from(JSON.stringify({ url: URL, headers: headers(`\${env:${ENV}}`, ro) })).toString('base64'))}`,
  }),
  gemini: (ro) => ({
    target: '~/.gemini/settings.json (user level)',
    project: 'For one repository: .gemini/settings.json.',
    lang: 'json',
    snippet: json({ mcpServers: { github: { httpUrl: URL, headers: headers(`$${ENV}`, ro) } } }),
  }),
  opencode: (ro) => ({
    target: '~/.config/opencode/opencode.json (user level)',
    project: 'For one repository: opencode.json.',
    lang: 'json',
    snippet: json({ mcp: { github: { type: 'remote', url: URL, enabled: true, oauth: false, headers: headers(`{env:${ENV}}`, ro) } } }),
  }),
  copilot: (ro) => ({
    target: 'Copilot CLI MCP config (run /mcp in Copilot CLI to find the file)',
    lang: 'json',
    snippet: json({ mcpServers: { github: { type: 'http', url: URL, headers: headers(`\${${ENV}}`, ro) } } }),
  }),
  vscode: (ro) => ({
    target: 'VS Code user configuration (command: "MCP: Open User Configuration"). VS Code signs in to GitHub itself, so no token is needed.',
    project: 'For one repository: .vscode/mcp.json.',
    lang: 'json',
    snippet: json({ servers: { github: { type: 'http', url: URL, headers: { 'X-MCP-Toolsets': TOOLSETS, ...(ro ? { 'X-MCP-Readonly': 'true' } : {}) } } } }),
    noToken: true,
    link: `https://insiders.vscode.dev/redirect/mcp/install?name=github&config=${encodeURIComponent(JSON.stringify({ type: 'http', url: URL, headers: { 'X-MCP-Toolsets': TOOLSETS, ...(ro ? { 'X-MCP-Readonly': 'true' } : {}) } }))}`,
  }),
  windsurf: (ro) => ({
    target: '~/.codeium/windsurf/mcp_config.json. Windsurf does not expand environment variables: the user replaces YOUR_GITHUB_PAT by hand.',
    lang: 'json',
    snippet: json({ mcpServers: { github: { serverUrl: URL, headers: headers('YOUR_GITHUB_PAT', ro) } } }),
  }),
};

const USAGE = `Usage: npx gh-wat-dis mcp <${'CLIENTS'}> [--read-write]        print the config for one harness
       npx gh-wat-dis mcp --apply [--scope user|project] [--client a,b] [--read-write] [--dry-run]
                                                     write it for every harness found on this machine`;

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['read-write', 'json', 'apply', 'dry-run', 'help'], strings: ['scope', 'client'], aliases: { '-h': '--help', '-n': '--dry-run' } });
  const usage = USAGE.replace('CLIENTS', Object.keys(CLIENTS).join('|'));
  if (args.help) { console.log(usage); return 0; }
  if (args.apply) {
    const scope = (args.scope ?? 'user') as Scope;
    if (!SCOPES.includes(scope)) throw new UsageError('--scope must be user or project');
    const clients = args.client ? args.client.split(',').map((c) => c.trim()).filter(Boolean) : detectClients();
    const unknown = clients.find((c) => !TARGETS[c]);
    if (unknown) throw new UsageError(`cannot write the config for "${unknown}". It can for: ${Object.keys(TARGETS).join(', ')}. Print the snippet instead: npx gh-wat-dis mcp ${unknown}`);
    if (!clients.length) { console.log('No supported harness found on this machine. Name one: --client claude,codex,cursor,gemini,opencode'); return 1; }
    const results = clients.map((c) => applyClient(c, { scope, readonly: !args['read-write'], dryRun: args['dry-run'] }));
    printApplied(results);
    if (args['dry-run']) console.log('\nDry run. Nothing changed.');
    return results.some((r) => r.action === 'failed') ? 1 : 0;
  }
  const client = args._[0];
  const make = client ? CLIENTS[client] : undefined;
  if (!client || !make) {
    console.error(usage);
    return 2;
  }
  const readonly = !args['read-write'];
  const c = make(readonly);
  if (args.json) {
    console.log(json({ client, readonly, env: c.noToken ? null : ENV, ...c }));
    return 0;
  }
  console.log(`GitHub MCP server for ${client}`);
  console.log(`Target: ${c.target}\n`);
  console.log(c.snippet);
  console.log('');
  if (c.link) console.log(`One click: open this link and confirm in ${client === 'vscode' ? 'VS Code' : 'Cursor'}.\n  ${c.link}\n`);
  if (c.note) console.log(c.note);
  if (!c.noToken) {
    if (process.env[ENV]) {
      console.log(`Token: ${ENV} is already set in this environment. Nothing to create.`);
    } else {
      const other = ['GITHUB_MCP_PAT', 'GITHUB_PAT', 'GITHUB_TOKEN', 'GH_TOKEN'].find((n) => process.env[n]);
      console.log(`Token: the snippet reads ${ENV} from the environment, and it is not set.`);
      console.log(other
        ? `  ${other} is set. Reuse it: export ${ENV}="$${other}"`
        : `  Keep it out of your global shell profile. Put this line in ${ENV_FILE} (git-ignored by "init") and load that file for this project with direnv or mise:\n    ${ENV}=<token>\n  Or, for one session: ${ENV}="$(gh auth token)" ${client}`);
    }
    console.log('Do not paste the token into a config file or a chat.');
  }
  console.log(readonly
    ? 'Mode: read-only. gh-wat-dis writes through the gh CLI. Pass --read-write to let the MCP server write too.'
    : 'Mode: read-write.');
  if (c.project) console.log(c.project);
  console.log(c.lang === 'bash' ? 'Run the command, restart the harness, then call get_me to check.' : 'Merge the snippet into the file. Keep every other entry. Restart the harness, then call get_me to check.');
  return 0;
}
