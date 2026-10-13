import type { DiagramSpec } from '../spec.ts';
import { collapse, focus } from './ops.ts';
import { descendants, statusOf } from './select.ts';

export interface Views { overview: DiagramSpec; details: { id: string; spec: DiagramSpec }[]; groups: string[] }

/**
 * The groups to split on: the outermost elements that hold others. A lone wrapper
 * (one system or runtime around everything) is opened so the split is not a single box.
 */
export function splitGroups(spec: DiagramSpec): string[] {
  const kids = (id: string | undefined): string[] => spec.elements.filter((e) => e.parent === id).map((e) => e.id);
  const holds = (id: string): boolean => kids(id).length > 0;
  let level = kids(undefined).filter(holds);
  while (level.length === 1 && kids(level[0]).some(holds)) level = kids(level[0]).filter(holds);
  return level;
}

/**
 * One overview with every group folded to a box, and one detail view per group that holds a change:
 * the group opened, its neighbours folded. Small diagrams read better on GitHub than one tall one.
 */
export function split(spec: DiagramSpec, opts: { groups?: string[]; all?: boolean } = {}): Views {
  const groups = opts.groups?.length ? opts.groups : splitGroups(spec);
  if (!groups.length) return { overview: spec, details: [], groups };
  const name = new Map(spec.elements.map((e) => [e.id, e.name]));
  const active = (id: string): boolean => {
    const inside = new Set([id, ...descendants(spec, id)]);
    return spec.elements.some((e) => inside.has(e.id) && statusOf(e) !== 'unchanged')
      || spec.relationships.some((r) => statusOf(r) !== 'unchanged' && (inside.has(r.from) || inside.has(r.to)));
  };
  const overview = { ...collapse(spec, { into: groups }), title: `${spec.title}: overview` };
  const details = groups.filter((g) => opts.all || active(g)).map((g) => {
    const others = groups.filter((o) => o !== g);
    const folded = others.length ? collapse(spec, { into: others }) : spec;
    return { id: g, spec: { ...focus(folded, { on: [g], hops: 1 }), title: `${spec.title}: ${name.get(g) ?? g}` } };
  });
  return { overview, details, groups };
}
