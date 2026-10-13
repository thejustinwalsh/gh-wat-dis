import { writeFileSync } from 'node:fs';
import { UsageError, parseArgs } from '../cli/util.ts';
import type { Command } from '../cli/util.ts';
import type { DiagramSpec } from '../spec.ts';
import { readPiped } from '../graph/input.ts';
import { lintSpec } from './lint.ts';
import { toMermaid } from './mermaid.ts';
import { renderSvg } from './svg.ts';
import { DETAILS } from '../spec.ts';
import type { Detail } from '../spec.ts';

const HELP = `Lint a diagram spec and draw it as SVG.

Usage: npx gh-wat-dis diagram [spec.json|-] [options]

  -o, --output <file>   where to write the SVG ("-" for stdout)
  --theme <name>        auto (default: follows the viewer's colour scheme), light, dark,
                        or split (needs -o; writes <name>.light.svg and <name>.dark.svg)
  --mermaid             print a Mermaid flowchart to stdout instead of drawing SVG
  --lint-only           check the spec and draw nothing
  --detail <level>      auto (default: descriptions only up to 5 elements), full, compact
  --no-lint             draw without checking

With no -o, a spec read from a file is drawn to <spec>.svg beside it and the path is printed.
A spec read from stdin is drawn to stdout. Written paths go to stdout, lint messages to stderr.
Exit 0 ok, 1 lint errors, 2 usage error.

Shape the spec first with "npx gh-wat-dis graph --help".
`;

const THEMES = ['auto', 'light', 'dark', 'split'] as const;
type Theme = (typeof THEMES)[number];

export const main: Command = async (argv) => {
  const args = parseArgs(argv, {
    booleans: ['help', 'mermaid', 'lint-only', 'no-lint'],
    strings: ['output', 'theme', 'detail'],
    aliases: { '-o': '--output', '-h': '--help' },
  });
  if (args.help) { process.stdout.write(HELP); return 0; }
  if (args._.length > 1) throw new UsageError('diagram takes one spec file');
  const detail = args.detail as Detail | undefined;
  if (detail && !DETAILS.includes(detail)) throw new UsageError(`--detail must be one of ${DETAILS.join(', ')}`);
  const theme = (args.theme ?? 'auto') as Theme;
  if (!THEMES.includes(theme)) throw new UsageError(`--theme must be one of ${THEMES.join(', ')}`);
  const file = args._[0] === '-' ? undefined : args._[0];
  const output = args.output;
  if (theme === 'split' && (!output || output === '-')) throw new UsageError('--theme split needs -o <file>');

  let spec: DiagramSpec;
  try { spec = JSON.parse(readPiped(args._[0])) as DiagramSpec; } catch (err) {
    if (err instanceof SyntaxError) throw new UsageError(`spec is not valid JSON: ${err.message}`);
    throw err;
  }

  if (!args['no-lint']) {
    const { errors, warnings } = lintSpec(spec);
    for (const w of warnings) console.error(`warning: ${w}`);
    for (const e of errors) console.error(`error: ${e}`);
    if (errors.length) return 1;
  }
  if (args['lint-only']) return 0;
  if (args.mermaid) { process.stdout.write(toMermaid(spec)); return 0; }

  const target = output ?? (file ? file.replace(/\.json$/i, '') + '.svg' : '-');
  if (theme === 'split') {
    const base = target.replace(/\.svg$/i, '');
    for (const t of ['light', 'dark'] as const) {
      writeFileSync(`${base}.${t}.svg`, await renderSvg(spec, { theme: t, detail }));
      console.log(`${base}.${t}.svg`);
    }
    return 0;
  }
  const svg = await renderSvg(spec, { theme, detail });
  if (target === '-') process.stdout.write(svg);
  else { writeFileSync(target, svg); console.log(target); }
  return 0;
};
