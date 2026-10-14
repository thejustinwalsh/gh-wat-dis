import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { UsageError, parseArgs } from '../cli/util.ts';
import { decideDiagram } from '../impact/decide.ts';
import type { Facts } from '../impact/types.ts';
import { lintBody } from './body.ts';
import type { DiagramCheck, Kind } from './body.ts';

const HELP = `Usage: npx gh-wat-dis lint <body.md|-> --kind issue|pr|milestone|comment [--facts <facts.json>] [--json]

Backstop check for a body before you post it: what GitHub would break, and gross shape errors.
It does not judge wording. Exits 1 when there are errors.

  --kind, -k <kind>  what the body is for: issue, pr, milestone or comment
  --facts <file>     impact facts for the change (npx gh-wat-dis impact > facts.json). With an issue
                     or a pr, warns when the facts say draw a diagram and the body has no image,
                     with the reason and the command that draws it. Says nothing when the facts
                     give a skip reason.
  --json             print errors and warnings as JSON
`;

function diagramCheck(file: string): DiagramCheck {
  let facts: Partial<Facts>;
  try { facts = JSON.parse(readFileSync(file, 'utf8')) as Partial<Facts>; } catch (e) {
    throw new UsageError(`--facts ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (facts?.schema !== 1 || !Array.isArray(facts.files) || !Array.isArray(facts.elements) || !facts.summary) {
    throw new UsageError(`--facts ${file} is not impact facts (expected the JSON that "gh-wat-dis impact" prints)`);
  }
  // Facts written before the decision was a fact still decide: the same rule, from what they hold.
  return { decision: facts.diagram ?? decideDiagram({ parts: [], complexity: [], symbols: [], edges: [], contracts: [], ...facts } as Facts), facts: file };
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['json', 'help'], strings: ['kind', 'facts'], aliases: { '-k': '--kind', '-h': '--help' } });
  if (args.help) { process.stdout.write(HELP); return 0; }
  const file = args._[0];
  if (!file || !args.kind) {
    process.stderr.write(HELP);
    return 2;
  }
  const text = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
  const dir = file === '-' ? process.cwd() : dirname(resolve(file));
  const res = lintBody(text, { kind: args.kind as Kind, exists: (p) => existsSync(resolve(dir, p)), ...(args.facts ? { diagram: diagramCheck(args.facts) } : {}) });
  if (args.json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    const where = (l: number): string => (l ? `${file}:${l}` : file);
    for (const e of res.errors) console.log(`error  ${where(e.line)}  ${e.msg}`);
    for (const w of res.warnings) console.log(`warn   ${where(w.line)}  ${w.msg}`);
    console.log(`${res.errors.length} errors, ${res.warnings.length} warnings.`);
  }
  return res.errors.length ? 1 : 0;
}
