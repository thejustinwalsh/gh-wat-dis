import { join } from 'node:path';
import type { Config } from './cli/config.ts';
import { CONFIG_REL, UsageError, parseArgs, readJson, repoRoot } from './cli/util.ts';
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

// `from-facts` and `from-config` make a spec. Every other `graph` op reshapes one.
export const main: Command = async (argv) => {
  if (argv[0] === 'from-facts') return (await import('./impact/cli.ts')).factsToSpec(argv.slice(1));
  if (argv[0] === 'from-config') return fromConfig(argv.slice(1));
  return (await import('./graph/cli.ts')).main(argv);
};
