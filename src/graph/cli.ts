import { UsageError, parseArgs } from '../cli/util.ts';
import type { Command } from '../cli/util.ts';
import type { DiagramSpec } from '../spec.ts';
import { readPiped } from './input.ts';
import { collapse, diff, drop, focus, ids, merge, rename, set, stats } from './ops.ts';
import { list, select } from './select.ts';

const HELP = `Reshape a diagram spec. Every op reads a spec (file, "-" or piped stdin) and writes a spec to stdout,
so ops chain with pipes and end in "npx gh-wat-dis diagram".

Usage: npx gh-wat-dis graph <op> [spec.json|-] [options]

  from-facts [facts.json]  spec from impact facts
  focus --on <id,id|status:changed,added> [--hops 1] [--direction both|in|out]
                           keep those elements, their neighbours within N hops, and every ancestor
  collapse --into <id,id> | --to-type <container|system|boundary>
                           fold everything inside an element into it; merge the relationships
  drop [--ids <a,b>] [--status <unchanged,...>] [--type <t,...>] [--external] [--orphans]
                           remove elements and their relationships
  merge <a.json> <b.json> [...]
                           union of specs; later files win field by field
  diff <base.json> <head.json>
                           one spec with added, removed and changed statuses
  set [--title t] [--type t] [--scope s] [--direction DOWN|RIGHT]
  set --element <id,id> key=value ...
  set --relationship <from>:<to>,<from>:* key=value ...   "*" matches any element
                           edit fields; "key=" deletes the key
  rename <oldId> <newId> [spec.json|-]
                           rename an id everywhere
  stats                    counts as JSON: elements, relationships, byType, byStatus, maxDepth, roots
  ids                      one line per element: id<TAB>type<TAB>status<TAB>name

Exit 0 ok, 2 usage error (an unknown id is a usage error).

Example
  npx gh-wat-dis graph focus --on status:changed,added,removed --hops 1 < big.json \\
    | npx gh-wat-dis graph collapse --to-type container \\
    | npx gh-wat-dis diagram -o change.svg
`;

function load(file: string | undefined): DiagramSpec {
  let spec: unknown;
  try { spec = JSON.parse(readPiped(file)); } catch (err) {
    if (err instanceof SyntaxError) throw new UsageError(`${file ?? 'stdin'} is not valid JSON: ${err.message}`);
    throw err;
  }
  const s = spec as Partial<DiagramSpec> | null;
  if (!s || !Array.isArray(s.elements) || !Array.isArray(s.relationships)) {
    throw new UsageError(`${file ?? 'stdin'} is not a diagram spec: it needs "elements" and "relationships" arrays`);
  }
  return s as DiagramSpec;
}

const one = (positional: string[]): string | undefined => {
  if (positional.length > 1) throw new UsageError(`expected one spec file, got ${positional.length}`);
  return positional[0];
};
const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';

const OPS: Record<string, (argv: string[]) => string> = {
  focus(argv) {
    const a = parseArgs(argv, { strings: ['on', 'hops', 'direction'] });
    if (!a.on) throw new UsageError('focus needs --on <id,id> or --on status:<status,...>');
    const hops = Number(a.hops ?? 1);
    if (!Number.isInteger(hops) || hops < 0) throw new UsageError('--hops must be a whole number');
    const direction = a.direction ?? 'both';
    if (direction !== 'both' && direction !== 'in' && direction !== 'out') throw new UsageError('--direction must be both, in or out');
    const spec = load(one(a._));
    return json(focus(spec, { on: select(spec, a.on), hops, direction }));
  },
  collapse(argv) {
    const a = parseArgs(argv, { strings: ['into', 'to-type'] });
    if (!a.into && !a['to-type']) throw new UsageError('collapse needs --into <id,id> or --to-type <type>');
    return json(collapse(load(one(a._)), { into: list(a.into), toType: a['to-type'] }));
  },
  drop(argv) {
    const a = parseArgs(argv, { strings: ['ids', 'status', 'type'], booleans: ['external', 'orphans'] });
    if (!a.ids && !a.status && !a.type && !a.external && !a.orphans) {
      throw new UsageError('drop needs one of --ids, --status, --type, --external, --orphans');
    }
    return json(drop(load(one(a._)), {
      ids: list(a.ids), status: list(a.status), type: list(a.type), external: a.external, orphans: a.orphans,
    }));
  },
  merge(argv) {
    const a = parseArgs(argv);
    if (a._.length < 2) throw new UsageError('merge needs two or more spec files');
    return json(merge(a._.map(load)));
  },
  diff(argv) {
    const a = parseArgs(argv);
    if (a._.length !== 2) throw new UsageError('diff needs <base.json> <head.json>');
    return json(diff(load(a._[0]), load(a._[1])));
  },
  set(argv) {
    const a = parseArgs(argv, { strings: ['title', 'type', 'scope', 'direction', 'element', 'relationship'] });
    const pairs = a._.filter((p) => p.includes('='));
    const fields = Object.fromEntries(pairs.map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
    const { _, ...opts } = a;
    return json(set(load(one(_.filter((p) => !p.includes('=')))), { ...opts, fields }));
  },
  rename(argv) {
    const a = parseArgs(argv);
    const [from, to, ...rest] = a._;
    if (!from || !to) throw new UsageError('rename needs <oldId> <newId>');
    return json(rename(load(one(rest)), { from, to }));
  },
  stats: (argv) => json(stats(load(one(parseArgs(argv)._)))),
  ids: (argv) => ids(load(one(parseArgs(argv)._))),
};

export const main: Command = async (argv) => {
  const [op, ...rest] = argv;
  if (!op || op === '--help' || op === '-h' || op === 'help' || rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  const run = OPS[op];
  if (!run) throw new UsageError(`unknown graph op "${op}" (one of from-facts, ${Object.keys(OPS).join(', ')})`);
  process.stdout.write(run(rest));
  return 0;
};
