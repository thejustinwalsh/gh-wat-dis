import { collapse, drop, focus } from '../graph/ops.ts';
import { select } from '../graph/select.ts';
import { split } from '../graph/split.ts';
import type { DiagramSpec } from '../spec.ts';
import { judge } from './fit.ts';
import type { FitOptions, Report } from './fit.ts';

/** A change to the spec or the options that the tool applied and judged again. */
export interface Fix {
  /** What to run or pass. */
  command: string;
  /** Size of the drawing after it, without the title and the key. */
  width: number;
  height: number;
  /** The warnings that are left after it. */
  warnings: string[];
  elements: number;
}

/**
 * When a drawing has warnings, this applies each filter that could mend it, lays the result out
 * and judges it again. It returns the ones that leave fewer warnings, best first, so a fix is
 * printed only after it was seen to work. `tried` names everything that was applied.
 */
export async function advise(spec: DiagramSpec, opts: FitOptions, report: Report): Promise<{ fixes: Fix[]; tried: string[] }> {
  const chosen = report.candidates.find((c) => c.chosen);
  const tries: { command: string; spec: DiagramSpec; opts: FitOptions }[] = [];
  const add = (command: string, make: () => DiagramSpec, o: FitOptions = opts): void => {
    try {
      const next = make();
      // A filter that changes nothing, or leaves nothing or an empty group, is not a fix.
      const parents = new Set(next.elements.map((e) => e.parent));
      const hollow = next.elements.some((e) => (e.type === 'boundary' || e.type === 'node') && !parents.has(e.id));
      if (next.elements.length < 2 || hollow) return;
      if (o === opts && next.elements.length === spec.elements.length && next.relationships.length === spec.relationships.length) return;
      tries.push({ command, spec: next, opts: o });
    } catch { /* the filter does not apply to this spec */ }
  };
  const marked = spec.elements.some((e) => e.status && e.status !== 'unchanged') || spec.relationships.some((r) => r.status && r.status !== 'unchanged');
  if (spec.type === 'code') {
    const outside = spec.elements.filter((e) => e.type === 'file' && !e.status).map((e) => e.id);
    if (outside.length) add(`graph drop --ids ${outside.join(',')} --orphans`, () => drop(spec, { ids: outside, orphans: true }));
  } else {
    if (marked) add('graph focus --on status:changed,added,removed --hops 1', () => focus(spec, { on: select(spec, 'status:changed,added,removed'), hops: 1 }));
    if (marked) add('graph drop --status unchanged --orphans', () => drop(spec, { status: ['unchanged'], orphans: true }));
    for (const type of ['container', 'system', 'boundary']) add(`graph collapse --to-type ${type}`, () => collapse(spec, { toType: type }));
    add('graph split (the overview)', () => split(spec).overview);
    if (chosen?.labels === 'text' && spec.type !== 'dynamic' && (opts.labels ?? spec.labels ?? 'auto') !== 'auto') add('--labels auto', () => spec, { ...opts, labels: 'auto' });
  }
  if (opts.direction) add(`no --direction ${opts.direction.toLowerCase()}`, () => spec, { ...opts, direction: undefined });
  if (opts.detail === 'full') add('no --detail full', () => spec, { ...opts, detail: undefined });

  const fixes: (Fix & { score: number })[] = [];
  for (const t of tries) {
    let next: Report;
    try { next = (await judge(t.spec, t.opts)).report; } catch { continue; }
    const c = next.candidates.find((k) => k.chosen)!;
    if (next.warnings.length >= report.warnings.length) continue;
    fixes.push({ command: t.command, width: c.width, height: c.height, warnings: next.warnings, elements: t.spec.elements.length, score: c.score });
  }
  fixes.sort((a, b) => a.warnings.length - b.warnings.length || b.elements - a.elements || a.score - b.score);
  return { fixes: fixes.slice(0, 3).map(({ score: _score, ...f }) => f), tried: tries.map((t) => t.command) };
}
