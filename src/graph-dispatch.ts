import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './cli/config.ts';
import { CONFIG_REL, UsageError, parseArgs, readInput, readJson, repoRoot } from './cli/util.ts';
import type { Command } from './cli/util.ts';
import type { DiagramSpec, DiagramType } from './spec.ts';

/** The architecture map in the repo config, as a diagram spec. */
export function configToSpec(cfg: Config, { title, type }: { title?: string; type?: DiagramType } = {}): DiagramSpec {
  const arch = cfg.architecture;
  const elements = arch.elements.map(({ paths: _paths, type: t, ...rest }) => ({ ...rest, type: t ?? 'container' as const }));
  return {
    title: title ?? arch.system.name,
    type: type ?? (elements.some((e) => e.type === 'component') ? 'component' : 'container'),
    scope: arch.system.name,
    elements,
    relationships: arch.relationships.map((r) => ({ ...r })),
  };
}

const fromConfig: Command = async (argv) => {
  const args = parseArgs(argv, { booleans: ['help'], strings: ['title', 'type', 'cwd'], aliases: { '-h': '--help' } });
  if (args.help) {
    console.log('Usage: npx gh-wat-dis graph from-config [--title t] [--type container|component|context] [--cwd dir]\nPrints the architecture map in .agents/gh-wat-dis/config.json as a diagram spec.');
    return 0;
  }
  const cfg = readJson<Config>(join(repoRoot(args.cwd), CONFIG_REL));
  if (!cfg?.architecture?.elements?.length) throw new UsageError(`no architecture elements in ${CONFIG_REL}. Map the system first (wat-architecture skill).`);
  console.log(JSON.stringify(configToSpec(cfg, { title: args.title, type: args.type as DiagramType | undefined }), null, 2));
  return 0;
};

const splitCmd: Command = async (argv) => {
  const args = parseArgs(argv, { booleans: ['help', 'all'], strings: ['out-dir', 'groups'], aliases: { '-h': '--help', '-o': '--out-dir' } });
  if (args.help || !args['out-dir']) {
    console.log('Usage: npx gh-wat-dis graph split [spec.json|-] --out-dir <dir> [--groups id,id] [--all]\nWrites overview.json (each group folded to one box) and one <group>.json per group that holds a change.\nPrints the files it wrote. Render each with "diagram". Default groups: the outermost elements that hold others.');
    return args.help ? 0 : 2;
  }
  const { split } = await import('./graph/split.ts');
  const spec = JSON.parse(readInput(args._[0])) as DiagramSpec;
  const views = split(spec, { groups: args.groups?.split(',').map((s) => s.trim()).filter(Boolean), all: args.all });
  const dir = args['out-dir'];
  mkdirSync(dir, { recursive: true });
  for (const [name, view] of [['overview', views.overview] as const, ...views.details.map((d) => [d.id, d.spec] as const)]) {
    const file = join(dir, `${name}.json`);
    writeFileSync(file, JSON.stringify(view, null, 2) + '\n');
    console.log(file);
  }
  if (!views.groups.length) console.error('note: the spec has no groups to split on. Set "parent" on elements, or pass --groups.');
  return 0;
};

// `from-facts` and `from-config` make a spec. Every other `graph` op reshapes one.
export const main: Command = async (argv) => {
  if (argv[0] === 'from-facts') return (await import('./impact/cli.ts')).factsToSpec(argv.slice(1));
  if (argv[0] === 'from-config') return fromConfig(argv.slice(1));
  if (argv[0] === 'split') return splitCmd(argv.slice(1));
  return (await import('./graph/cli.ts')).main(argv);
};
