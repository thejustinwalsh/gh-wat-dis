import { PKG, UsageError, errorMessage } from './cli/util.ts';
import type { Command } from './cli/util.ts';

type Loader = () => Promise<Command>;

/** What running a tool can change. `reads`: nothing. `local`: files on this machine. `github`: the repository on GitHub. */
export type Effect = 'reads' | 'local' | 'github';

/** One tool, described the way a harness lists a tool call: a name, what it is for, and what it changes. */
export interface Tool { name: string; group: string; usage: string; description: string; effect: Effect }

const gh = () => import('./gh/cli.ts');
const facts = () => import('./impact/cli.ts');
const setup = () => import('./cli/install.ts');
const draw = () => import('./diagram/cli.ts');

// Each entry loads its module only when the command runs.
const COMMANDS: Record<string, Loader> = {
  install: async () => (await setup()).install,
  uninstall: async () => (await setup()).uninstall,
  doctor: async () => (await import('./cli/doctor.ts')).main,
  init: async () => (await import('./cli/init.ts')).main,
  mcp: async () => (await import('./cli/mcp.ts')).main,
  related: async () => (await gh()).related,
  links: async () => (await gh()).links,
  labels: async () => (await gh()).labels,
  milestone: async () => (await gh()).milestone,
  issues: async () => (await gh()).issues,
  survey: async () => (await gh()).surveyCmd,
  relations: async () => (await gh()).relations,
  relate: async () => (await gh()).relateCmd,
  impact: async () => (await facts()).impact,
  blast: async () => (await facts()).blast,
  reach: async () => (await facts()).reach,
  owners: async () => (await facts()).owners,
  elements: async () => (await facts()).elements,
  graph: async () => (await import('./graph-dispatch.ts')).main,
  diagram: async () => (await draw()).main,
  legend: async () => (await draw()).legend,
  lint: async () => (await import('./lint/cli.ts')).main,
};

const SETUP = 'Set up';
const FACTS = 'Collect facts (JSON out)';
const WRITE = 'Change GitHub';
const GRAPH = 'Shape a graph (diagram spec in, diagram spec out)';
const RENDER = 'Render';
const CHECK = 'Check';

/** Every tool, in the order help prints them. The first word of `name` is the command. */
export const TOOLS: Tool[] = [
  { name: 'install', group: SETUP, effect: 'local', usage: 'install [--project] [--client <names>] [--mcp user|project|skip] [--dry-run] [--force]', description: 'Copy the wat skills to where each agent harness looks, then run the doctor checks.' },
  { name: 'uninstall', group: SETUP, effect: 'local', usage: 'uninstall [--project] [--client <names>] [--dry-run]', description: 'Remove the skill directories this package installed.' },
  { name: 'init', group: SETUP, effect: 'local', usage: 'init [--use always|ask|never] [--dry-run] [--force]', description: 'Write the repository config at .agents/gh-wat-dis/config.json: policy, labels, issue types, milestones, architecture map.' },
  { name: 'mcp', group: SETUP, effect: 'local', usage: 'mcp <client> | mcp --apply [--scope user|project] [--dry-run]', description: 'Print the GitHub MCP server config for a harness, or write it for every harness found here. Stores no token.' },
  { name: 'doctor', group: SETUP, effect: 'local', usage: 'doctor [--offline] [--json] [--no-login] [--mcp user|project|skip] [--tools install|skip]', description: 'Check the runtime, gh, the skills, the GitHub MCP server, the config and the optional tools. Offers a fix where it has one, and installs an optional tool when asked.' },

  { name: 'impact', group: FACTS, effect: 'reads', usage: 'impact [--base <ref>] [--head <ref>] [--working-tree] [--depth N] [--no-complexity]', description: 'Facts about a change: files, changed symbols, dependents, elements, contracts, owners, files that usually change together, and complexity moved (when cccc is installed). Each fact names its source.' },
  { name: 'reach', group: FACTS, effect: 'reads', usage: 'reach <path|path#symbol|symbol>... [--depth N]', description: 'Who depends on a file or an exported symbol. Needs no diff.' },
  { name: 'owners', group: FACTS, effect: 'reads', usage: 'owners <path>...', description: 'CODEOWNERS for paths, with the rule that matched.' },
  { name: 'elements', group: FACTS, effect: 'reads', usage: 'elements', description: 'The architecture elements and the files each one maps, from the config or from the workspace layout.' },
  { name: 'issues', group: FACTS, effect: 'reads', usage: 'issues [--queue] [--milestone <title>|none] [--limit N]', description: 'Open issues with type, surfaces, milestone, tracking flag and what each one is missing.' },
  { name: 'survey', group: FACTS, effect: 'reads', usage: 'survey | survey --issues [--missing] [--mine] [--milestone <title>|none] [--except <file>] [--limit 5]', description: 'What a repository with history holds before a migration: open issues by what they lack, facts on their bodies, labels outside the plan, open milestones. --issues prints the next batch.' },
  { name: 'related', group: FACTS, effect: 'reads', usage: 'related (--issue <n> | --title "<text>" [--body-file <file>]) [--kind issue|pr] [--md]', description: 'Issues and pull requests that share an error, an identifier, a file path or title words with a draft or an issue. Reports signals. It does not decide what is a duplicate.' },
  { name: 'links', group: FACTS, effect: 'reads', usage: 'links (--pr <n> | --body-file <file>) [--closes <n,n>|none] [--text]', description: 'Which issues a pull request closes on merge and which it only mentions, from the body and the commit messages. Exits non-zero when that differs from --closes.' },
  { name: 'relations', group: FACTS, effect: 'reads', usage: 'relations <issue>', description: "An issue's parent, sub-issues, blocked by and blocking, from GitHub's native relations." },
  { name: 'milestone', group: FACTS, effect: 'reads', usage: 'milestone [<title>] [--stalled-after 7]', description: 'Status numbers for a milestone: counts, what is in review, what is blocked, the done-when conditions, the tracking issue. No dates.' },
  { name: 'labels', group: FACTS, effect: 'reads', usage: 'labels [--text]', description: 'The agents, surface and type labels the config wants, compared with the labels on GitHub.' },

  { name: 'relate', group: WRITE, effect: 'github', usage: 'relate <issue> [--parent <n>] [--blocked-by <n,n>] [--blocks <n,n>] [--remove]', description: 'Set or remove a native relation between issues: parent, blocked by, blocks.' },
  { name: 'labels apply', group: WRITE, effect: 'github', usage: 'labels apply [--prune] [--dry-run]', description: 'Create and update the labels the config wants. --prune also deletes the others.' },

  { name: 'graph from-facts', group: GRAPH, effect: 'reads', usage: 'graph from-facts [facts.json|-] [--all] [--title t]', description: 'A diagram spec from impact facts: the changed and reached elements with their status.' },
  { name: 'graph from-config', group: GRAPH, effect: 'reads', usage: 'graph from-config [--title t] [--type container|component|context]', description: "A diagram spec of the whole architecture map in the repository's config." },
  { name: 'graph focus', group: GRAPH, effect: 'reads', usage: 'graph focus [spec.json|-] --on <id,id|status:changed,added> [--hops 1] [--direction both|in|out]', description: 'Keep some elements, their neighbours within N hops, and every ancestor.' },
  { name: 'graph collapse', group: GRAPH, effect: 'reads', usage: 'graph collapse [spec.json|-] (--into <id,id> | --to-type container|system|boundary)', description: 'Fold everything inside an element into it and merge the relationships.' },
  { name: 'graph drop', group: GRAPH, effect: 'reads', usage: 'graph drop [spec.json|-] [--ids <a,b>] [--status <s,...>] [--type <t,...>] [--external] [--orphans]', description: 'Remove elements and their relationships.' },
  { name: 'graph merge', group: GRAPH, effect: 'reads', usage: 'graph merge <a.json> <b.json> [...]', description: 'The union of several specs. Later files win field by field.' },
  { name: 'graph diff', group: GRAPH, effect: 'reads', usage: 'graph diff <base.json> <head.json>', description: 'One spec that marks what was added, removed and changed between two specs.' },
  { name: 'graph set', group: GRAPH, effect: 'reads', usage: 'graph set [spec.json|-] [--title t] [--element <id,id> key=value ...] [--relationship <from>:<to> key=value ...]', description: 'Edit fields of the spec, of elements or of relationships. "key=" deletes the key.' },
  { name: 'graph rename', group: GRAPH, effect: 'reads', usage: 'graph rename <oldId> <newId> [spec.json|-]', description: 'Rename an element id everywhere in a spec.' },
  { name: 'graph split', group: GRAPH, effect: 'local', usage: 'graph split [spec.json|-] --out-dir <dir>', description: 'Write an overview spec plus one small spec for each changed group.' },
  { name: 'graph stats', group: GRAPH, effect: 'reads', usage: 'graph stats [spec.json|-]', description: 'Counts for a spec: elements, relationships, by type, by status, depth.' },
  { name: 'graph ids', group: GRAPH, effect: 'reads', usage: 'graph ids [spec.json|-]', description: 'One line for each element: id, type, status, name.' },

  { name: 'diagram', group: RENDER, effect: 'local', usage: 'diagram [spec.json|-] [-o out.svg] [--png out.png] [--theme auto|light|dark|split] [--lint-only] [--mermaid]', description: "Lint a diagram spec and draw it as an SVG fitted to GitHub's width. --png adds a PNG to look at." },
  { name: 'legend', group: RENDER, effect: 'reads', usage: 'legend [spec.json|-]', description: "A spec's relationships as a Markdown table, to sit under a diagram with numbered lines." },
  { name: 'blast', group: RENDER, effect: 'reads', usage: 'blast [facts.json|-] [--max-items 5] [--no-heading] [--no-links]', description: 'Impact facts as a Markdown "Blast radius" section: what the change reaches outside its diff, with file links.' },

  { name: 'lint', group: CHECK, effect: 'reads', usage: 'lint <body.md|-> --kind issue|pr|milestone|comment [--json]', description: 'Backstop check of a body before it is posted: what GitHub would break, and gross shape errors. It does not judge wording.' },
];

const EFFECTS: Record<Effect, string> = { reads: '', local: ' [writes local files]', github: ' [writes to GitHub]' };

/** The tool list as text: one tool to a line, the way a harness lists its tool calls. */
export function helpText(): string {
  const width = Math.max(...TOOLS.map((t) => t.name.length)) + 2;
  const groups = [...new Set(TOOLS.map((t) => t.group))].map((g) => [
    g, ...TOOLS.filter((t) => t.group === g).map((t) => `  ${t.name.padEnd(width)}${t.description}${EFFECTS[t.effect]}`),
  ].join('\n'));
  return `gh-wat-dis ${PKG.version}
Small tools for agents that write GitHub issues, pull requests and milestones.

Usage: npx gh-wat-dis <tool> [options]

Every tool does one thing. Data goes out as JSON on stdout, so tools chain with pipes.
"-" or piped stdin stands in for a file argument. A tool with no mark below only reads.

${groups.join('\n\n')}

Example
  npx gh-wat-dis impact | npx gh-wat-dis graph from-facts \\
    | npx gh-wat-dis graph focus --on status:changed,added,removed --hops 1 \\
    | npx gh-wat-dis diagram -o change.svg

npx gh-wat-dis <tool> --help    options of one tool
npx gh-wat-dis help --json      this list as JSON: name, group, usage, description, effect
Docs: ${PKG.homepage}
`;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    if (rest.includes('--json')) console.log(JSON.stringify({ name: PKG.name, version: PKG.version, run: 'npx gh-wat-dis <name> [options]', tools: TOOLS }, null, 2));
    else process.stdout.write(helpText());
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
