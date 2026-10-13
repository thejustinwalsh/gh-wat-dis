import { writeFileSync } from 'node:fs';
import { UsageError, parseArgs } from '../cli/util.ts';
import type { Command } from '../cli/util.ts';
import type { DiagramSpec } from '../spec.ts';
import { readPiped } from '../graph/input.ts';
import { lintSpec } from './lint.ts';
import { toMermaid } from './mermaid.ts';
import { render, renderSvg } from './svg.ts';
import { MAX_WIDTH } from './fit.ts';
import { toLegend } from './legend.ts';
import { DETAILS, LABEL_MODES } from '../spec.ts';
import type { Detail, LabelMode } from '../spec.ts';

const HELP = `Lint a diagram spec and draw it as SVG.

Usage: npx gh-wat-dis diagram [spec.json|-] [options]

  -o, --output <file>   where to write the SVG ("-" for stdout)
  --theme <name>        auto (default: follows the viewer's colour scheme), light, dark,
                        or split (needs -o; writes <name>.light.svg and <name>.dark.svg)
  --mermaid             print a Mermaid flowchart to stdout instead of drawing SVG
  --lint-only           check the spec and draw nothing
  --detail <level>      auto (default: descriptions only up to 5 elements), full, compact
  --labels <mode>       auto (default), text, numbered. Numbered lines need the table from "legend".
  --direction <d>       down or right. Default: whichever fits the width better.
  --max-width <px>      width to fit (default 860, the GitHub issue body)
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
    strings: ['output', 'theme', 'detail', 'labels', 'direction', 'max-width'],
    aliases: { '-o': '--output', '-h': '--help' },
  });
  if (args.help) { process.stdout.write(HELP); return 0; }
  if (args._.length > 1) throw new UsageError('diagram takes one spec file');
  const detail = args.detail as Detail | undefined;
  if (detail && !DETAILS.includes(detail)) throw new UsageError(`--detail must be one of ${DETAILS.join(', ')}`);
  const labels = args.labels as LabelMode | undefined;
  if (labels && !LABEL_MODES.includes(labels)) throw new UsageError(`--labels must be one of ${LABEL_MODES.join(', ')}`);
  const direction = args.direction?.toUpperCase() as 'DOWN' | 'RIGHT' | undefined;
  if (direction && direction !== 'DOWN' && direction !== 'RIGHT') throw new UsageError('--direction must be down or right');
  const maxWidth = args['max-width'] ? Number(args['max-width']) : MAX_WIDTH;
  const opts = { detail, labels, direction, maxWidth };
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
      writeFileSync(`${base}.${t}.svg`, await renderSvg(spec, { ...opts, theme: t }));
      console.log(`${base}.${t}.svg`);
    }
    return 0;
  }
  const out = await render(spec, { ...opts, theme });
  if (target === '-') process.stdout.write(out.svg);
  else { writeFileSync(target, out.svg); console.log(target); }
  console.error(`${out.width} x ${out.height}px, ${out.direction === 'RIGHT' ? 'left to right' : 'top down'}${out.compact ? ', compact' : ''}${out.numbered ? ', numbered lines' : ''}`);
  if (out.numbered && spec.type !== 'dynamic') {
    console.error(`note: lines are numbered so the diagram fits. Put the table under the image: npx gh-wat-dis legend ${file ?? '<spec.json>'}`);
  }
  if (out.width > maxWidth) {
    console.error(`warning: ${out.width}px is wider than GitHub's ${maxWidth}px body, so text will shrink. Cut elements with "graph focus" or "graph collapse", or split into two diagrams.`);
  }
  return 0;
};

/** The relationships of a spec as a Markdown table, to sit under a diagram with numbered lines. */
export const legend: Command = async (argv) => {
  const args = parseArgs(argv, { booleans: ['help'], aliases: { '-h': '--help' } });
  if (args.help) {
    console.log('Usage: npx gh-wat-dis legend [spec.json|-]\nPrints the relationships of a diagram spec as a Markdown table: number, from, to, what, how.');
    return 0;
  }
  process.stdout.write(toLegend(JSON.parse(readPiped(args._[0])) as DiagramSpec));
  return 0;
};
