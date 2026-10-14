import { collapse, drop, focus } from '../graph/ops.ts';
import { select } from '../graph/select.ts';
import type { DiagramSpec, DiagramType } from '../spec.ts';
import { active } from './vocab.ts';

/**
 * What one diagram of each type holds and still reads at GitHub's width: boxes (elements that are
 * not groups) and lines. Past it the layout has nothing good to choose from, so the spec is cut
 * before it is drawn. The generators stay inside it, and lint names the filter that brings a
 * hand-written spec back in.
 */
export const BUDGET: Record<DiagramType, { boxes: number; lines: number }> = {
  context: { boxes: 8, lines: 10 },
  container: { boxes: 12, lines: 16 },
  component: { boxes: 12, lines: 16 },
  code: { boxes: 8, lines: 14 },
  dynamic: { boxes: 8, lines: 8 },
  deployment: { boxes: 12, lines: 14 },
  landscape: { boxes: 12, lines: 14 },
};
/** A label on a line, and the name of a group, in characters. Longer ones make every layout wider or taller. */
export const LABEL_BUDGET = 80;
export const GROUP_NAME_BUDGET = 40;

/** The boxes and lines of a spec as the renderer counts them. */
export function load(spec: DiagramSpec): { boxes: number; lines: number } {
  const parents = new Set(spec.elements.map((e) => e.parent));
  const ids = new Set(spec.elements.map((e) => e.id));
  return {
    boxes: spec.elements.filter((e) => !parents.has(e.id) && e.type !== 'boundary' && e.type !== 'node').length,
    lines: spec.relationships.filter((r) => ids.has(r.from) && ids.has(r.to)).length,
  };
}

/** What the spec has too much of, in words. Empty when it is within its budget. */
export function over(spec: DiagramSpec): string[] {
  const budget = BUDGET[spec.type];
  if (!budget) return [];
  const have = load(spec);
  // A flow has its own rule for steps, in lint.
  return [
    ...(have.boxes > budget.boxes ? [`${have.boxes} elements is more than the ${budget.boxes} a ${spec.type} diagram holds`] : []),
    ...(have.lines > budget.lines && spec.type !== 'dynamic' ? [`${have.lines} relationships is more than the ${budget.lines} a ${spec.type} diagram holds`] : []),
  ];
}

/**
 * The first filter that brings the spec inside its budget and keeps the change, as a command with
 * what it leaves. The filters are tried in the order of what they cost the picture: the elements
 * round the change, then unchanged elements dropped, then groups folded.
 */
export function trim(spec: DiagramSpec): { command: string; boxes: number; lines: number } | undefined {
  const marked = spec.elements.some((e) => active(e.status)) || spec.relationships.some((r) => active(r.status));
  const tries: [string, () => DiagramSpec][] = [];
  if (spec.type === 'code') {
    const outside = spec.elements.filter((e) => e.type === 'file' && !e.status).map((e) => e.id);
    if (outside.length) tries.push([`graph drop --ids ${outside.join(',')}`, () => drop(spec, { ids: outside })]);
  } else {
    if (marked) tries.push(['graph focus --on status:changed,added,removed --hops 1', () => focus(spec, { on: select(spec, 'status:changed,added,removed'), hops: 1 })]);
    if (marked) tries.push(['graph drop --status unchanged --orphans', () => drop(spec, { status: ['unchanged'], orphans: true })]);
    for (const type of ['container', 'system', 'boundary']) tries.push([`graph collapse --to-type ${type}`, () => collapse(spec, { toType: type })]);
  }
  const kept = (next: DiagramSpec): boolean => {
    const ids = new Set(next.elements.map((e) => e.id));
    // Folding an element into its group keeps it in the picture. Dropping one that changed does not.
    return spec.elements.every((e) => !active(e.status) || ids.has(e.id) || (e.parent !== undefined && ids.has(e.parent)));
  };
  for (const [command, make] of tries) {
    try {
      const next = make();
      if (next.elements.length >= 2 && kept(next) && !over(next).length) return { command, ...load(next) };
    } catch { /* the filter does not apply to this spec */ }
  }
  return undefined;
}
