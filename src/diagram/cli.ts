import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { UsageError, parseArgs } from '../cli/util.ts';
import type { Command } from '../cli/util.ts';
import type { DiagramSpec } from '../spec.ts';
import { readPiped } from '../graph/input.ts';
import { lintSpec } from './lint.ts';
import { toMermaid } from './mermaid.ts';
import { render, renderSvg } from './svg.ts';
import { MAX_WIDTH } from './fit.ts';
import { advise } from './advise.ts';
import type { Fix } from './advise.ts';
import { toLegend } from './legend.ts';
import { DETAILS, LABEL_MODES } from '../spec.ts';
import type { Detail, LabelMode } from '../spec.ts';

const HELP = `Lint a diagram spec and draw it as SVG.

Usage: npx gh-wat-dis diagram [spec.json|-] [options]

  -o, --output <file>   where to write the SVG ("-" for stdout)
  --png <file>          also write a PNG of the drawing at 2x, to look at it. Light colours unless --theme dark.
                        GitHub gets the SVG: do not attach the PNG.
  --theme <name>        auto (default: follows the viewer's colour scheme), light, dark,
                        or split (needs -o; writes <name>.light.svg and <name>.dark.svg)
  --mermaid             print a Mermaid flowchart to stdout instead of drawing SVG
  --lint-only           check the spec and draw nothing
  --detail <level>      auto (default: descriptions only up to 5 elements), full, compact
  --labels <mode>       auto (default), text, numbered. Numbered lines need the table from "legend".
  --direction <d>       down or right. Default: the direction the spec names, else the form of the diagram type.
                        A direction named here or in the spec is never overridden.
  --report              print the judgement as JSON to stdout in place of the written paths: the size, the
                        layout kept and why, the rung, the warnings, and the metrics and failed gates of every layout tried
  --max-width <px>      width to fit (default 860, the GitHub issue body)
  --no-lint             draw without checking

With no -o, a spec read from a file is drawn to <spec>.svg beside it and the path is printed.
A spec read from stdin is drawn to stdout. Written paths go to stdout, lint messages to stderr.

Each type of diagram has one form. A code diagram is layers of files by import depth, left to right, three
layers at most: a line ends on a symbol row, files that import one another share a layer, and the name of a
group is a label on each of its cards. A flow reads in step order from the top left. The rest read from the
first relationship in the spec, top down or left to right. The order of the relationships is the reading
order: in a cycle, the line that returns to an element already drawn is the one drawn backwards.

A layout must pass every gate: each relationship drawn from end to end on its own element or row, no line
through text, nothing on top of anything else, calm lines (none runs more than twice as far as it needs to,
and at most one crossing for every four lines), and the whole image no wider than --max-width and no taller
than 1.6 times that. The form is loosened one rung at a time until a layout passes: numbers on the lines or a
long chain wrapped, then both, then compact cards. A code diagram is never wrapped. The first rung that
passes is drawn. On one rung, the layout with the fewest crossings wins, then the least detour, then the
fewest corners, then the shape nearest 1.6 wide to 1 tall. A layout that passes and is taller than 900px
gives way to the wrapped layout of the next rung when that one is nearer 1.6 to 1 and its lines are as calm.

Stderr gets the size, then a "layout:" line with what was kept, the rung, and why each rung above it failed.
When no rung passes, the layout with the calmest lines is drawn, then the one that overshoots least, and the
"layout:" line says so. Then a "warning:" for each fault that is left. After the warnings, each "fix:" line is
a filter or option the tool applied and judged again, with the size and the warnings it leaves. Only a fix
that leaves fewer warnings, or that makes a drawing pass which no rung could, is printed.
Exit 0 ok, 1 lint errors, 2 usage error.

Shape the spec first with "npx gh-wat-dis graph --help".
`;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const THEMES = ['auto', 'light', 'dark', 'split'] as const;
type Theme = (typeof THEMES)[number];

export const main: Command = async (argv) => {
  const args = parseArgs(argv, {
    booleans: ['help', 'mermaid', 'lint-only', 'no-lint', 'report'],
    strings: ['output', 'theme', 'detail', 'labels', 'direction', 'max-width', 'png'],
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
  const maxWidth = args['max-width'] === undefined ? MAX_WIDTH : Number(args['max-width']);
  if (!Number.isInteger(maxWidth) || maxWidth < 300) throw new UsageError(`--max-width must be a whole number of pixels, 300 or more, got "${args['max-width']}"`);
  const opts = { detail, labels, direction, maxWidth };
  const theme = (args.theme ?? 'auto') as Theme;
  if (!THEMES.includes(theme)) throw new UsageError(`--theme must be one of ${THEMES.join(', ')}`);
  const file = args._[0] === '-' ? undefined : args._[0];
  const output = args.output;
  if (theme === 'split' && (!output || output === '-')) throw new UsageError('--theme split needs -o <file>');

  let spec: DiagramSpec;
  try { spec = JSON.parse(readPiped(args._[0])) as DiagramSpec; } catch (err) {
    if (err instanceof SyntaxError) throw new UsageError(`spec is not valid JSON: ${err.message}`);
    // A file that is not there is a mistake in the command, like any other bad argument.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'EISDIR') throw new UsageError(`cannot read the spec file "${args._[0]}"`);
    throw err;
  }

  if (args['lint-only'] && (args['no-lint'] || args.png || args.report || args.mermaid)) throw new UsageError('--lint-only checks the spec and draws nothing: do not combine it with --no-lint, --png, --report or --mermaid');
  if (args.png && args.png === (args.output ?? (file ? file.replace(/\.json$/i, '') + '.svg' : undefined))) throw new UsageError('--png and the SVG would be the same file: give the PNG a name of its own');
  // A code diagram's lines are imports with no words, so there is nothing to number.
  if (labels === 'numbered' && spec.type === 'code') throw new UsageError('a code diagram has no words on its lines to number: leave off --labels numbered');
  if (args.png) {
    const folder = dirname(resolvePath(args.png));
    if (!existsSync(folder)) throw new UsageError(`cannot write "${args.png}": its folder does not exist`);
  }
  if (!args['no-lint']) {
    const { errors, warnings } = lintSpec(spec);
    for (const w of warnings) console.error(`warning: ${w}`);
    for (const e of errors) console.error(`error: ${e}`);
    if (errors.length) return 1;
  }
  if (args['lint-only']) return 0;
  if (args.mermaid && (args.png || args.report)) throw new UsageError('--mermaid prints text and draws nothing: do not combine it with --png or --report');
  if (args.mermaid) { process.stdout.write(toMermaid(spec)); return 0; }
  /** A path that cannot be written is a mistake in the command, said in plain words. */
  const write = (path: string, data: string | Uint8Array): void => {
    try { writeFileSync(path, data); } catch (err) {
      throw new UsageError(`cannot write "${path}": ${(err as NodeJS.ErrnoException).code === 'ENOENT' ? 'its folder does not exist' : (err as NodeJS.ErrnoException).code === 'EISDIR' ? 'it is a folder' : errorText(err)}`);
    }
  };

  const target = output ?? (file ? file.replace(/\.json$/i, '') + '.svg' : '-');
  if (args.report && (target === '-' || theme === 'split')) throw new UsageError('--report prints JSON to stdout: give -o <file>, and do not combine it with --theme split');
  if (args.png && theme === 'split') throw new UsageError('--png draws one image: do not combine it with --theme split');
  if (theme === 'split') {
    const base = target.replace(/\.svg$/i, '');
    for (const t of ['light', 'dark'] as const) {
      write(`${base}.${t}.svg`, await renderSvg(spec, { ...opts, theme: t }));
      console.log(`${base}.${t}.svg`);
    }
    return 0;
  }
  const out = await render(spec, { ...opts, theme });
  const say = (path: string): void => { if (!args.report) console.log(path); };
  if (target === '-') process.stdout.write(out.svg);
  else { write(target, out.svg); say(target); }
  console.error(`${out.width} x ${out.height}px, ${out.direction === 'RIGHT' ? 'left to right' : 'top down'}${out.compact ? ', compact' : ''}${out.numbered ? ', numbered lines' : ''}`);
  if (labels === 'numbered' && !out.numbered) console.error('note: no line of this diagram has words, so there is nothing to number. The lines are drawn as they are.');
  if (out.numbered && spec.type !== 'dynamic') {
    console.error(`note: lines are numbered so the diagram fits. Put the table under the image: npx gh-wat-dis legend ${file ?? '<spec.json>'}`);
  }
  console.error(`layout: ${out.report.why}`);
  const { warnings } = out.report;
  for (const w of warnings) console.error(`warning: ${w}`);
  // A fix is printed only after the tool applied it and judged the result.
  let fixes: Fix[] = [];
  if (warnings.length) {
    const advice = await advise(spec, opts, out.report);
    fixes = advice.fixes;
    for (const f of fixes) {
      const gives = f.command.endsWith('the largest') ? '' : ' gives';
      console.error(`fix: ${f.command}${gives} ${f.width} x ${f.height}px with ${f.warnings.length ? `${f.warnings.length} ${f.warnings.length === 1 ? 'warning' : 'warnings'}, where there ${warnings.length === 1 ? 'was 1' : `were ${warnings.length}`}` : 'no warning'}.${f.removes ? ` It ${f.removes}.` : ''}`);
    }
    // A code diagram is cut by file, or split by group: `graph split` writes one diagram for each.
    const byHand = spec.type === 'code' ? 'Take files out with `graph drop --ids <path,path>`, or draw one diagram for each group with `graph split`.' : 'Cut elements by hand, or draw two diagrams.';
    if (!fixes.length) {
      console.error(advice.tried.length
        ? `fix: none found. Tried and judged no better: ${advice.tried.join('; ')}. ${byHand}`
        : `fix: none to try on this spec. ${byHand}`);
    }
  }
  if (args.png) {
    // The PNG needs fixed colours: the default SVG picks its scheme with CSS the rasterizer does not read.
    const { toPng } = await import('../tools/raster.ts');
    const image = toPng(theme === 'auto' ? await renderSvg(spec, { ...opts, theme: 'light' }) : out.svg);
    write(args.png, image.png);
    if (image.emoji) console.error(`note: the PNG draws a small box for each of the ${image.emoji} emoji in the text. The SVG holds the emoji and GitHub draws them.`);
    if (target !== '-') say(args.png); else console.error(args.png);
  }
  if (args.report) {
    const { width, height } = out;
    console.log(JSON.stringify({
      svg: target, ...(args.png ? { png: args.png } : {}), width, height, maxWidth,
      direction: out.direction, labels: out.numbered ? 'numbered' : 'text', compact: out.compact,
      why: out.report.why, rung: out.report.rung, rungs: out.report.rungs, passed: out.report.passed, warnings, fixes, candidates: out.report.candidates,
    }, null, 2));
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
