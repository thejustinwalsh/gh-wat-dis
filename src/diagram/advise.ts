import { collapse, drop, focus } from '../graph/ops.ts';
import { select } from '../graph/select.ts';
import { split, splitGroups } from '../graph/split.ts';
import type { DiagramSpec } from '../spec.ts';
import type { FitOptions, Report } from './fit.ts';
import { render } from './svg.ts';
import { active } from './vocab.ts';

/** A change to the spec or the options that the tool applied, drew and judged again. */
export interface Fix {
  /** What to run or pass. */
  command: string;
  /** Size of the whole image after it: the numbers the size line will print. For a split, the largest of the diagrams. */
  width: number;
  height: number;
  /** The warnings that are left after it. */
  warnings: string[];
  elements: number;
  /** What the fix takes out of the picture, in words. Empty when it removes nothing. */
  removes: string;
}

const GROUP_NAME_MAX = 32;
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * When a drawing has warnings, this applies each filter that could mend it, draws the result and
 * judges it again. It returns the ones that leave fewer warnings, best first, so a fix is printed
 * only after it was seen to work. A fix never takes out an element or a line that the change
 * added, changed or removed: the picture is of the change. `tried` names everything that was applied.
 */
export async function advise(spec: DiagramSpec, opts: FitOptions, report: Report): Promise<{ fixes: Fix[]; tried: string[] }> {
  const chosen = report.candidates.find((c) => c.chosen);
  const relKey = (r: DiagramSpec['relationships'][number]): string => `${r.from}\0${r.to}\0${r.label}\0${r.toSymbol ?? ''}\0${r.fromSymbol ?? ''}`;
  const tries: { command: string; specs: DiagramSpec[]; opts: FitOptions; removes: string }[] = [];
  /** `folds`: the filter merges elements into their group, so an element may go as long as its group stays. */
  const add = (command: string, make: () => DiagramSpec | DiagramSpec[], o: FitOptions = opts, folds = false): void => {
    try {
      const made = make();
      const specs = Array.isArray(made) ? made : [made];
      if (!specs.length) return;
      const ids = new Set(specs.flatMap((s) => s.elements.map((e) => e.id)));
      const rels = new Set(specs.flatMap((s) => s.relationships.map(relKey)));
      const goneEls = spec.elements.filter((e) => !ids.has(e.id));
      const goneRels = spec.relationships.filter((r) => !rels.has(relKey(r)));
      for (const next of specs) {
        // A filter that leaves nothing or an empty group is not a fix.
        const parents = new Set(next.elements.map((e) => e.parent));
        if (next.elements.length < 2 || next.elements.some((e) => (e.type === 'boundary' || e.type === 'node') && !parents.has(e.id))) return;
      }
      if (o === opts && !goneEls.length && !goneRels.length && specs.length === 1 && specs[0]!.direction === spec.direction && JSON.stringify(specs[0]!.elements.map((e) => e.name)) === JSON.stringify(spec.elements.map((e) => e.name))) return;
      // The change itself is never cut: what it added, changed or removed stays in the picture.
      if (!folds && (goneEls.some((e) => active(e.status)) || goneRels.some((r) => active(r.status)))) return;
      const names = goneEls.slice(0, 3).map((e) => `"${e.name}"`).join(', ') + (goneEls.length > 3 ? ` and ${goneEls.length - 3} more` : '');
      const removes = folds ? (goneEls.length ? `folds ${plural(goneEls.length, 'element')} into ${goneEls.length === 1 ? 'its group' : 'their groups'}` : '')
        : [goneEls.length ? `removes ${plural(goneEls.length, 'unchanged element')} (${names})` : '', goneRels.length ? `${goneEls.length ? '' : 'removes '}${plural(goneRels.length, 'unchanged line')}` : ''].filter(Boolean).join(' and ');
      tries.push({ command, specs, opts: o, removes });
    } catch { /* the filter does not apply to this spec */ }
  };
  const marked = spec.elements.some((e) => active(e.status)) || spec.relationships.some((r) => active(r.status));
  if (spec.type === 'code') {
    // Files outside the diff are context. Dropping them leaves every changed card in place, lines or not.
    const outside = spec.elements.filter((e) => e.type === 'file' && !e.status).map((e) => e.id);
    if (outside.length) add(`graph drop --ids ${outside.join(',')}`, () => drop(spec, { ids: outside }));
  } else {
    if (marked) add('graph focus --on status:changed,added,removed --hops 1', () => focus(spec, { on: select(spec, 'status:changed,added,removed'), hops: 1 }));
    if (marked) add('graph drop --status unchanged --orphans', () => drop(spec, { status: ['unchanged'], orphans: true }));
    for (const type of ['container', 'system', 'boundary']) add(`graph collapse --to-type ${type}`, () => collapse(spec, { toType: type }), opts, true);
    // One group at a time: the innermost groups first, where a fold costs the least detail.
    const kids = new Set(spec.elements.map((e) => e.parent));
    const depth = (id: string | undefined, n = 0): number => { const p = spec.elements.find((e) => e.id === id)?.parent; return p === undefined || n > 20 ? n : depth(p, n + 1); };
    const groups = spec.elements.filter((e) => kids.has(e.id)).sort((a, b) => depth(b.id) - depth(a.id)).slice(0, 6);
    for (const g of groups) add(`graph collapse --into ${g.id}`, () => collapse(spec, { into: [g.id] }), opts, true);
  }
  if (splitGroups(spec).length > 1) add('graph split', () => { const v = split(spec); return [v.overview, ...v.details.map((d) => d.spec)]; }, opts, true);
  const long = spec.elements.filter((e) => kids(spec).has(e.id) && [...e.name].length > GROUP_NAME_MAX);
  if (long.length) {
    add(`shorten the group name${long.length === 1 ? '' : 's'} ${long.map((e) => `"${[...e.name].slice(0, 24).join('')}…"`).join(', ')} to ${GROUP_NAME_MAX} characters or fewer`,
      () => ({ ...spec, elements: spec.elements.map((e) => (long.includes(e) ? { ...e, name: [...e.name].slice(0, GROUP_NAME_MAX).join('') } : e)) }));
  }
  if (chosen?.labels === 'text' && spec.type !== 'dynamic' && (opts.labels ?? spec.labels ?? 'auto') !== 'auto') add('--labels auto', () => spec, { ...opts, labels: 'auto' });
  // A direction that was named is never overridden, so leaving it off is a fix like any other.
  if (opts.direction) add(`no --direction ${opts.direction.toLowerCase()}`, () => spec, { ...opts, direction: undefined });
  else if (spec.direction) add('graph set --direction ""', () => { const { direction: _direction, ...rest } = spec; return rest; });
  if (opts.detail === 'full') add('no --detail full', () => spec, { ...opts, detail: undefined });

  const fixes: (Fix & { score: number })[] = [];
  for (const t of tries) {
    let worst: Fix | undefined;
    try {
      for (const s of t.specs) {
        const out = await render(s, t.opts);
        const fix: Fix = { command: t.command, width: out.width, height: out.height, warnings: out.report.warnings, elements: s.elements.length, removes: t.removes };
        if (!worst || fix.warnings.length > worst.warnings.length || (fix.warnings.length === worst.warnings.length && fix.height > worst.height)) worst = fix;
      }
    } catch { continue; }
    if (!worst || worst.warnings.length >= report.warnings.length) continue;
    fixes.push({ ...worst, ...(t.specs.length > 1 ? { command: `${t.command} gives ${t.specs.length} diagrams, the largest` } : {}), score: worst.height });
  }
  fixes.sort((a, b) => a.warnings.length - b.warnings.length || b.elements - a.elements || a.score - b.score);
  return { fixes: fixes.slice(0, 3).map(({ score: _score, ...f }) => f), tried: tries.map((t) => t.command) };
}

const kids = (spec: DiagramSpec): Set<string | undefined> => new Set(spec.elements.map((e) => e.parent));
