import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, UsageError } from '../cli/util.ts';
import { lintBody } from '../lint/body.ts';
import { lintSpec, render, renderSvg, renderHtmlDocument, toLegend } from '../diagram/index.ts';
import { toPng } from '../tools/raster.ts';
import { toCodeSpec } from '../impact/to-code-spec.ts';
import { toDiagramSpec } from '../impact/to-spec.ts';
import type { Facts } from '../impact/types.ts';
import type { DiagramSpec } from '../spec.ts';
import type { DisItem, DisPr } from './types.ts';
import { readCache, stampInput, writeBundle } from './cache.ts';
import type { Artifact, Bundle, DiagramFormat, Pass, StampInput } from './cache.ts';
import { explain, issueDiagram } from './explain.ts';
import { attachmentLinks, downloadAttachment, saveAttachment } from './attachment.ts';

export interface DisOptions { cwd: string; full?: boolean; diagramSpec?: DiagramSpec; format?: DiagramFormat }
export interface DisDependencies {
  readItem: (input: string, opts: { cwd: string }) => Promise<DisItem>;
  readStamp: (input: string, opts: { cwd: string }) => Promise<StampInput>;
  measure: (item: DisPr, opts: { cwd: string }) => Promise<Facts>;
  download: (url: string) => Promise<Uint8Array>;
}
export interface DisResult extends Bundle { cached: boolean; drift: string[] }

/** Complete one pass without executing any instruction found in thread text. */
export async function describe(input: string, opts: DisOptions, deps: DisDependencies): Promise<DisResult> {
  const format = opts.format ?? 'svg';
  if (!['svg', 'html'].includes(format)) throw new UsageError('--format must be svg or html');
  if (format === 'html' && !opts.full) throw new UsageError('--format html needs --full');
  if (opts.diagramSpec) {
    if (!opts.full) throw new UsageError('--diagram-spec needs --full');
    const { errors } = lintSpec(opts.diagramSpec);
    if (errors.length) throw new UsageError(`the authored diagram spec is invalid: ${errors.join('; ')}`);
  }
  const mode: Pass = opts.full ? 'full' : 'quick';
  const live = await deps.readStamp(input, { cwd: opts.cwd });
  const cached = readCache(live, opts.cwd, mode, opts.full ? format : 'any');
  if (cached.bundle && !opts.diagramSpec) return { ...cached.bundle, cached: true, drift: [] };
  const item = await deps.readItem(input, { cwd: opts.cwd });
  // The second read owns the stamp if the source moved while its thread was being collected.
  const preserved = lintBody(item.body, { kind: item.kind }).errors.length === 0;
  const bundle = await writeBundle(item, opts.cwd, mode, async (stage) => {
    const warnings: string[] = [], notes: string[] = [];
    const files: Partial<Record<Artifact, string>> & { markdown: string; source: string } = { markdown: 'explain.md', source: 'source.json' };
    writeFileSync(join(stage, files.source), JSON.stringify(item, null, 2) + '\n');
    let diagramSource: string | undefined, localMap: { path: string; digest: string } | undefined;
    if (preserved && !opts.diagramSpec && format === 'svg') for (const url of attachmentLinks(item.body)) {
      try {
        Object.assign(files, saveAttachment(await deps.download(url), stage));
        diagramSource = `Attached image from ${url}`;
        break;
      } catch (error) { warnings.push(`Could not preserve the attached image: ${error instanceof Error ? error.message : String(error)}. The source URL remains in the body.`); }
    }
    let facts: Facts | undefined, spec: DiagramSpec | undefined, legend: string | undefined;
    if (opts.full && !files.png && !files.svg) {
      if (item.kind === 'pr') {
        facts = await deps.measure(item, { cwd: opts.cwd });
        if (facts.base !== item.baseSha || facts.head !== item.headSha) throw new Error('the measured PR range does not match the source base and head');
        writeFileSync(join(stage, 'facts.json'), JSON.stringify(facts, null, 2) + '\n');
        files.facts = 'facts.json';
        const decision = facts.diagram;
        if (opts.diagramSpec && decision.level !== 'dynamic') throw new UsageError('--diagram-spec is supported for measured dynamic decisions or full issues');
        if (!decision.draw) notes.push(`No diagram: ${decision.skip}.`);
        else if (decision.level === 'dynamic') {
          if (opts.diagramSpec && opts.diagramSpec.type !== 'dynamic') throw new UsageError('a measured dynamic decision needs a dynamic authored spec');
          if (opts.diagramSpec) { spec = opts.diagramSpec; diagramSource = 'Supplied authored spec; its call order is not verified by impact'; }
          else notes.push('The measured change reorders calls. A call-sequence diagram needs authored steps; supply it with --full --diagram-spec <file>.');
        }
        else {
          spec = decision.level === 'code' ? toCodeSpec(facts, { title: item.title }).spec : toDiagramSpec(facts, { title: item.title });
          diagramSource = `Measured PR diff ${item.baseSha}…${item.headSha}; ${decision.reasons.join('; ')}`;
        }
      } else if (opts.diagramSpec) {
        spec = opts.diagramSpec;
        diagramSource = 'Supplied authored spec; no PR diff measured';
      } else {
        const mapped = issueDiagram(item, opts.cwd);
        spec = mapped.spec;
        diagramSource = mapped.source;
        localMap = mapped.localMap;
        if (mapped.note) notes.push(mapped.note);
      }
    }
    if (spec) {
      const lint = lintSpec(spec);
      if (lint.errors.length || !spec.elements.length) notes.push(`The source-grounded diagram could not be drawn: ${lint.errors.join('; ') || 'no elements to draw'}.`);
      else {
        const drawing = await render(spec, { structured: format === 'html' });
        writeFileSync(join(stage, 'spec.json'), JSON.stringify(spec, null, 2) + '\n');
        const diagramFile = `diagram.${format}`;
        writeFileSync(join(stage, diagramFile), format === 'html' ? renderHtmlDocument(spec, drawing) : drawing.svg);
        writeFileSync(join(stage, 'diagram.png'), toPng(await renderSvg(spec, { theme: 'light' })).png);
        Object.assign(files, { spec: 'spec.json', [format]: diagramFile, png: 'diagram.png' });
        warnings.push(...lint.warnings, ...drawing.report.warnings);
        if (drawing.numbered) legend = toLegend(spec).trim();
      }
    }
    if (!files.png && !files.svg) { diagramSource = undefined; localMap = undefined; }
    warnings.push(...notes);
    const markdown = preserved ? item.body : explain(item, facts, notes, files.png ? `![Diagram](diagram.png)${legend ? `\n\n${legend}` : ''}` : undefined);
    writeFileSync(join(stage, 'explain.md'), markdown);
    return { format, path: preserved ? 'body' : 'generated', files, warnings, ...(diagramSource ? { diagramSource } : {}), ...(localMap ? { localMap } : {}) };
  });
  return { ...bundle, cached: !!bundle.publicationReused, drift: cached.drift };
}

const HELP = `Usage: gh-wat-dis dis <n|owner/repo#n|URL> [--full [--diagram-spec file] [--format svg|html]] [--json] [--cwd dir]

Explain an issue or PR with its source and diagram. The quick pass reads GitHub without fetching git.
--full measures an unformatted PR or supplies a missing diagram from its diff; an issue uses a matching
local architecture map when its source names one. A body that passes lint is preserved as written.

--diagram-spec supplies a linted authored diagram for a dynamic decision or a full issue; it requires
--full and always rebuilds the bundle. The caller authors the sequence from source.

--format html writes a standalone HTML diagram with structured inline SVG and a PNG preview.
It requires --full and generates from a spec rather than embedding a downloaded attachment.

Outputs live in .agents/gh-wat-dis/dis/<owner>/<repo>/<n>/ under the caller's project.
Matching full caches also answer quick reads. --json prints one JSON object; otherwise paths and Markdown.
`;

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['help', 'full', 'json'], strings: ['cwd', 'diagram-spec', 'format'], aliases: { '-h': '--help' } });
  if (args.help) { process.stdout.write(HELP); return 0; }
  if (args._.length !== 1) throw new UsageError(HELP.trim());
  if (args['diagram-spec'] && !args.full) throw new UsageError('--diagram-spec needs --full');
  if (args.format && !['svg', 'html'].includes(args.format)) throw new UsageError('--format must be svg or html');
  if (args.format === 'html' && !args.full) throw new UsageError('--format html needs --full');
  let diagramSpec: DiagramSpec | undefined;
  if (args['diagram-spec']) {
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(args['diagram-spec'], 'utf8')); } catch (error) { throw new UsageError(`cannot read diagram spec \"${args['diagram-spec']}\": ${error instanceof Error ? error.message : String(error)}`); }
    const { errors } = lintSpec(parsed);
    if (errors.length) throw new UsageError(`the authored diagram spec is invalid: ${errors.join('; ')}`);
    diagramSpec = parsed as DiagramSpec;
  }
  const { readItem, readItemStamp } = await import('../gh/item.ts');
  const result = await describe(args._[0]!, { cwd: args.cwd ?? process.cwd(), full: !!args.full, format: (args.format ?? 'svg') as DiagramFormat, ...(diagramSpec ? { diagramSpec } : {}) }, {
    readItem, readStamp: readItemStamp,
    measure: async (item, opts) => (await import('./measure.ts')).measurePr(item, opts),
    download: downloadAttachment,
  });
  for (const line of result.drift) console.error(`drift: ${line}`);
  for (const warning of result.stamp.warnings) console.error(`note: ${warning}`);
  if (args.json) process.stdout.write(JSON.stringify({ schema: 1, item: stampInput(result.stamp), mode: result.stamp.mode, format: result.stamp.format ?? 'svg', path: result.stamp.path, cached: result.cached, drift: result.drift, paths: result.paths, markdown: result.markdown, warnings: result.stamp.warnings, diagramSource: result.stamp.diagramSource }, null, 2) + '\n');
  else {
    const lines = [`${result.cached ? 'Reused' : 'Wrote'} ${result.stamp.mode} read of ${result.stamp.repo}#${result.stamp.number}.`, result.stamp.path === 'body' ? 'Preserved the GitHub body as written (lint found no errors; it is a format backstop).' : 'Generated a sourced summary from the thread.', ...(result.stamp.diagramSource ? [`Diagram source: ${result.stamp.diagramSource}`] : []), ...Object.entries(result.paths).map(([key, path]) => `${key}: ${path}`), '', result.markdown];
    if (!args.full && result.stamp.mode !== 'full' && result.stamp.path !== 'body') lines.push('', `For the full report, run npx gh-wat-dis dis ${result.stamp.url} --full.`);
    process.stdout.write(lines.join('\n') + '\n');
  }
  return 0;
}
