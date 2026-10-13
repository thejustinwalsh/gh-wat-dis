import type { Command } from './cli/util.ts';

// `graph from-facts` turns impact facts into a spec, so it lives with the facts code.
// Every other `graph` op reshapes a spec.
export const main: Command = async (argv) => {
  if (argv[0] === 'from-facts') return (await import('./impact/cli.ts')).factsToSpec(argv.slice(1));
  return (await import('./graph/cli.ts')).main(argv);
};
