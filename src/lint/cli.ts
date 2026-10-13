import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from '../cli/util.ts';
import { lintBody } from './body.ts';
import type { Kind } from './body.ts';

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['json'], strings: ['kind'], aliases: { '-k': '--kind' } });
  const file = args._[0];
  if (!file || !args.kind) {
    console.error('Usage: npx gh-wat-dis lint <body.md> --kind issue|pr|milestone|comment [--json]');
    return 2;
  }
  const text = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
  const dir = file === '-' ? process.cwd() : dirname(resolve(file));
  const res = lintBody(text, { kind: args.kind as Kind, exists: (p) => existsSync(resolve(dir, p)) });
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
