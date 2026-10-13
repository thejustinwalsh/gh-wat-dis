import { PKG, UsageError, errorMessage } from './cli/util.ts';
import type { Command } from './cli/util.ts';

type Loader = () => Promise<Command>;

// Each entry loads its module only when the command runs.
const COMMANDS: Record<string, Loader> = {
  install: async () => (await import('./cli/install.ts')).install,
  uninstall: async () => (await import('./cli/install.ts')).uninstall,
  doctor: async () => (await import('./cli/doctor.ts')).main,
  init: async () => (await import('./cli/init.ts')).main,
  mcp: async () => (await import('./cli/mcp.ts')).main,
  related: async () => (await import('./gh/cli.ts')).related,
  links: async () => (await import('./gh/cli.ts')).links,
  impact: async () => (await import('./impact/cli.ts')).impact,
  blast: async () => (await import('./impact/cli.ts')).blast,
  reach: async () => (await import('./impact/cli.ts')).reach,
  owners: async () => (await import('./impact/cli.ts')).owners,
  elements: async () => (await import('./impact/cli.ts')).elements,
  graph: async () => (await import('./graph-dispatch.ts')).main,
  diagram: async () => (await import('./diagram/cli.ts')).main,
  lint: async () => (await import('./lint/cli.ts')).main,
};

const HELP = `gh-wat-dis ${PKG.version}
Small tools for agents that write GitHub issues, pull requests and milestones.

Usage: npx gh-wat-dis <command> [options]

Every tool does one thing. Data goes out as JSON on stdout, so tools chain with pipes.
"-" or piped stdin stands in for a file argument.

Set up
  install [--project] [--client claude,agents] [--dry-run] [--force]
  uninstall [--project]
  init [--use always|ask|never] [--force]     write .agents/gh-wat-dis/config.json
  mcp <client>                                print GitHub MCP server config for a harness
  doctor [--offline] [--json]                 check skills, gh, MCP server, repo config

Collect facts (JSON out)
  impact [--base <ref>] [--working-tree]      what a change touches and reaches
  reach <path|path#symbol|symbol>...          who depends on a file or symbol, no diff needed
  owners <path>...                            CODEOWNERS for paths
  elements                                    architecture elements and the files they map
  related (--issue <n> | --title "<t>")       issues and PRs that share signals with a draft
  links (--pr <n> | --body-file <f>)          what a PR closes on merge, what it only mentions

Shape a graph (diagram spec in, diagram spec out)
  graph from-facts [facts.json]               spec from impact facts
  graph from-config                           spec from the repo's architecture map
  graph focus|collapse|drop|merge|diff|set|rename
  graph stats|ids                             inspect a spec

Render
  diagram [spec.json] [-o out.svg]            lint a spec and draw it as SVG
  blast [facts.json]                          impact facts as a Markdown "Blast radius" section

Check
  lint <body.md> --kind issue|pr|milestone    backstop: catch what GitHub would break

Example
  npx gh-wat-dis impact | npx gh-wat-dis graph from-facts \\
    | npx gh-wat-dis graph focus --on status:changed,added,removed --hops 1 \\
    | npx gh-wat-dis diagram -o change.svg

Run "npx gh-wat-dis <command> --help" for a command's options.
Docs: ${PKG.homepage}
`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    console.log(PKG.version);
    return 0;
  }
  const load = COMMANDS[cmd];
  if (!load) {
    console.error(`gh-wat-dis: unknown command "${cmd}". Run "npx gh-wat-dis help".`);
    return 2;
  }
  try {
    return await (await load())(rest);
  } catch (err) {
    console.error(`gh-wat-dis ${cmd}: ${errorMessage(err)}`);
    if (process.env.WAT_DEBUG && err instanceof Error) console.error(err.stack);
    return err instanceof UsageError ? 2 : 1;
  }
}
