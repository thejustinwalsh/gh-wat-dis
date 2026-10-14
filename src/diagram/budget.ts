import { collapse, drop, focus } from '../graph/ops.ts';
import { select } from '../graph/select.ts';
import type { DiagramSpec, DiagramType } from '../spec.ts';
import { CODE_LAYERS, CODE_LAYER_HEIGHT, codeShape } from './code-shape.ts';
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
  // A code diagram is also held to three layers of files, and to layers that fit the height of one image.
  const deep: string[] = [];
  if (spec.type === 'code') {
    const shape = codeShape(spec);
    if (shape.depth > CODE_LAYERS) deep.push(`imports ${shape.depth} files deep is more than the ${CODE_LAYERS} layers a code diagram holds`);
    const tallest = Math.max(...shape.heights);
    if (tallest > CODE_LAYER_HEIGHT) deep.push(`a layer of files about ${Math.round(tallest)}px tall is more than the ${CODE_LAYER_HEIGHT}px one image holds`);
  }
  // A flow has its own rule for steps, in lint.
  return [
    ...deep,
    ...(have.boxes > budget.boxes ? [`${have.boxes} elements is more than the ${budget.boxes} a ${spec.type} diagram holds`] : []),
    ...(have.lines > budget.lines && spec.type !== 'dynamic' ? [`${have.lines} relationships is more than the ${budget.lines} a ${spec.type} diagram holds`] : []),
  ];
}

const isChanged = (status: string | undefined): boolean => status === 'added' || status === 'changed' || status === 'removed';

/**
 * The files to take out of a code diagram that is too deep or has a layer too tall, a step at a time.
 * Too deep: the files that stand past the three layers, those outside the diff first. A layer too tall:
 * the last file of that layer that is outside the diff, and when there is none, its last changed file.
 * The first file of the spec, the one the diagram is about, is never the one to go. Empty when nothing is to cut.
 */
export function codeCut(spec: DiagramSpec): string[] {
  if (spec.type !== 'code') return [];
  const shape = codeShape(spec);
  const byId = new Map(spec.elements.map((e) => [e.id, e]));
  const first = spec.elements.find((e) => e.type === 'file')?.id;
  if (shape.depth > CODE_LAYERS) {
    const far = shape.beyond.filter((id) => !isChanged(byId.get(id)!.status));
    if (far.length) return far;
    if (shape.beyond.some((id) => id !== first)) return shape.beyond.filter((id) => id !== first);
  }
  const tall = shape.heights.findIndex((h) => h > CODE_LAYER_HEIGHT);
  if (tall < 0) return [];
  const inLayer = spec.elements.filter((e) => shape.layer.get(e.id) === tall && e.id !== first);
  const pick = inLayer.filter((e) => !isChanged(e.status)).at(-1) ?? inLayer.at(-1);
  return pick ? [pick.id] : [];
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
    // The files past the third layer and the last files of a layer that is too tall, taken out until the diagram fits.
    const far: string[] = [];
    let next = spec;
    for (let cut = codeCut(next), n = 0; cut.length && n < 16; cut = codeCut(next), n++) { far.push(...cut); next = drop(next, { ids: cut }); }
    if (far.length) { const cutSpec = next; tries.push([`graph drop --ids ${far.join(',')}`, () => cutSpec]); }
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
    // In a code diagram a file outside the diff may carry the affected mark, and may still go.
    const mine = (status: string | undefined): boolean => (spec.type === 'code' ? isChanged(status) : active(status as never) !== undefined);
    return spec.elements.every((e) => !mine(e.status) || ids.has(e.id) || (e.parent !== undefined && ids.has(e.parent)));
  };
  for (const [command, make] of tries) {
    try {
      const next = make();
      if (next.elements.length >= 2 && kept(next) && !over(next).length) return { command, ...load(next) };
    } catch { /* the filter does not apply to this spec */ }
  }
  return undefined;
}
