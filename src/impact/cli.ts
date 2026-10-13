import { UsageError, parseArgs, readInput } from '../cli/util.ts';
import type { Command } from '../cli/util.ts';
import { analyze, DEFAULT_DEPTH } from './analyze.ts';
import { locate } from '../tools/cccc.ts';
import { toMarkdown } from './markdown.ts';
import { listElements, reachOf, resolveOwners } from './reach.ts';
import { toDiagramSpec } from './to-spec.ts';
import type { Facts } from './types.ts';

const ALIASES = { '-h': '--help' };
const json = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); };
const help = (text: string): number => { process.stdout.write(text); return 0; };

function count(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${name} must be a whole number, got "${value}"`);
  return n;
}

function readFacts(file: string | undefined): Facts {
  let facts: Partial<Facts>;
  try { facts = JSON.parse(readInput(file)) as Partial<Facts>; } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError(`input is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (facts?.schema !== 1 || !Array.isArray(facts.elements) || !Array.isArray(facts.edges) || !facts.summary) {
    throw new UsageError('input is not impact facts (expected the JSON that "gh-wat-dis impact" prints)');
  }
  return facts as Facts;
}

const IMPACT_HELP = `Usage: gh-wat-dis impact [--base <ref>] [--head <ref>] [--working-tree] [--depth N] [--no-complexity] [--cwd dir]

Collect facts about a change: files, changed symbols, dependents, elements, owners. Prints Facts JSON.

  --base <ref>      base side (default: merge-base of head with the default branch)
  --head <ref>      head side (default: HEAD)
  --working-tree    compare base with the working tree: staged, unstaged and untracked files
  --depth N         import hops to follow for transitive dependents (default ${DEFAULT_DEPTH})
  --no-complexity   do not run cccc
  --cwd dir         repository to read (default: current directory)

With cccc installed (npx gh-wat-dis doctor --tools install), complexity[] lists each function whose
cognitive or cyclomatic complexity the change moved, with the score before and after.
Every fact has a provenance label (exact, resolved, measured, heuristic) and a source.
`;

export const impact: Command = async (argv) => {
  const a = parseArgs(argv, { booleans: ['working-tree', 'help', 'no-complexity'], strings: ['base', 'head', 'depth', 'cwd'], aliases: ALIASES });
  if (a.help) return help(IMPACT_HELP);
  if (a._.length) throw new UsageError(`unexpected argument "${a._[0]}"`);
  if (a['working-tree'] && a.head) throw new UsageError('--working-tree and --head cannot be combined');
  json(await analyze({
    ...(a.cwd ? { cwd: a.cwd } : {}), ...(a.base ? { base: a.base } : {}), ...(a.head ? { head: a.head } : {}),
    workingTree: !!a['working-tree'], depth: count(a.depth, 'depth', DEFAULT_DEPTH),
    ...(a['no-complexity'] ? {} : { cccc: locate()?.path ?? null }),
  }));
  return 0;
};

const BLAST_HELP = `Usage: gh-wat-dis blast [facts.json|-] [--max-items 5] [--heading "<text>"] [--no-heading] [--no-links]

Format impact facts as a Markdown "Blast radius" section. Reads Facts JSON from a file or stdin.

  --max-items N     entries per list before "+N more" (default 5)
  --heading <text>  heading line (default "## Blast radius")
  --no-heading      print no heading
  --no-links        print file paths as code, not as links to the file at the head commit

Paths link to the repository when the facts name one (the origin remote) and the head is a commit.
Push the branch before you post the section, or the links lead nowhere.
`;

export const blast: Command = async (argv) => {
  const a = parseArgs(argv, { booleans: ['help', 'no-heading', 'no-links'], strings: ['max-items', 'heading'], aliases: ALIASES });
  if (a.help) return help(BLAST_HELP);
  process.stdout.write(toMarkdown(readFacts(a._[0]), {
    maxItems: count(a['max-items'], 'max-items', 5),
    ...(a['no-links'] ? { links: false } : {}),
    ...(a['no-heading'] ? { heading: false as const } : a.heading !== undefined ? { heading: a.heading } : {}),
  }));
  return 0;
};

const REACH_HELP = `Usage: gh-wat-dis reach <path|path#symbol|symbol>... [--depth N] [--cwd dir]

Who depends on a file or an exported symbol. Needs no diff. Prints JSON.

  path           a tracked file
  path#symbol    one exported symbol of a file
  symbol         an exported symbol name; every file that declares it is listed

  --depth N      import hops to follow for the transitive rollup (default ${DEFAULT_DEPTH})
  --cwd dir      repository to read (default: current directory)
`;

export const reach: Command = async (argv) => {
  const a = parseArgs(argv, { booleans: ['help'], strings: ['depth', 'cwd'], aliases: ALIASES });
  if (a.help) return help(REACH_HELP);
  if (!a._.length) throw new UsageError('name at least one path, path#symbol or symbol');
  const result = await reachOf({ targets: a._, depth: count(a.depth, 'depth', DEFAULT_DEPTH), ...(a.cwd ? { cwd: a.cwd } : {}) });
  json(result);
  const missing = result.targets.filter((t) => !t.found);
  for (const t of missing) console.error(`gh-wat-dis reach: no tracked file or exported symbol matches "${t.target}"`);
  return missing.length ? 1 : 0;
};

const OWNERS_HELP = `Usage: gh-wat-dis owners <path>... [--cwd dir]
       gh-wat-dis owners - [--cwd dir]        paths on stdin, one per line

CODEOWNERS for paths. Reads .github/CODEOWNERS, CODEOWNERS or docs/CODEOWNERS; the last matching pattern wins.
Prints JSON: [{ path, owners, rule, file, line, provenance }].
`;

export const owners: Command = async (argv) => {
  const a = parseArgs(argv, { booleans: ['help'], strings: ['cwd'], aliases: ALIASES });
  if (a.help) return help(OWNERS_HELP);
  const fromStdin = !a._.length || (a._.length === 1 && a._[0] === '-');
  const paths = fromStdin ? readInput(a._[0]).split('\n').map((l) => l.trim()).filter(Boolean) : a._;
  json(await resolveOwners({ paths, ...(a.cwd ? { cwd: a.cwd } : {}) }));
  return 0;
};

const ELEMENTS_HELP = `Usage: gh-wat-dis elements [--cwd dir]

Architecture elements and the files they map. Prints JSON: { mapping, elements, unmapped }.

  mapping "config"     elements and globs from .agents/gh-wat-dis/config.json (architecture.elements[].paths)
  mapping "workspace"  npm workspace packages and Cargo workspace crates
  mapping "directory"  top-level directories
`;

export const elements: Command = async (argv) => {
  const a = parseArgs(argv, { booleans: ['help'], strings: ['cwd'], aliases: ALIASES });
  if (a.help) return help(ELEMENTS_HELP);
  if (a._.length) throw new UsageError(`unexpected argument "${a._[0]}"`);
  json(await listElements(a.cwd ? { cwd: a.cwd } : {}));
  return 0;
};

const SPEC_HELP = `Usage: gh-wat-dis graph from-facts [facts.json|-] [--title "<t>"] [--all]

Turn impact facts into a diagram spec. Reads Facts JSON from a file or stdin, prints the spec.

  --title <t>   diagram title
  --all         every element and edge in the facts
                (default: changed, added and removed elements plus their direct neighbours)

Nothing else is pruned. Shape the result with "gh-wat-dis graph focus|collapse|drop|merge".
`;

export const factsToSpec: Command = async (argv) => {
  const a = parseArgs(argv, { booleans: ['help', 'all'], strings: ['title'], aliases: ALIASES });
  if (a.help) return help(SPEC_HELP);
  const spec = toDiagramSpec(readFacts(a._[0]), { all: !!a.all, ...(a.title !== undefined ? { title: a.title } : {}) });
  if (!spec.elements.length) console.error('gh-wat-dis graph from-facts: no changed elements in the facts; pass --all for the whole map');
  json(spec);
  return 0;
};
