import type { DiagramSpec, SpecElement, SpecRelationship } from '../spec.ts';
import type { EdgeFact, Facts, SpecOptions } from './types.ts';

function label(e: EdgeFact): string {
  if (e.label) return e.label;
  if (e.weight > 0) return `imports (${e.weight})`;
  return e.source === 'manifest' ? 'declares dependency' : 'imported on base (0 on head)';
}

/**
 * Facts as a diagram spec: the elements the change touched, the ones it reaches, and both ends of
 * every relationship it added or removed, with their ancestors. An unchanged neighbour that the
 * change does not reach is left out: next to a changed hub, that is most of the map.
 * A top-level folder that only stands in for an element is not drawn.
 * `all` keeps the whole map, for the `graph` tool to reshape.
 */
export function toDiagramSpec(facts: Facts, opts: SpecOptions = {}): DiagramSpec {
  const byId = new Map(facts.elements.map((e) => [e.id, e]));
  const keep = new Set<string>();
  if (opts.all) for (const e of facts.elements) keep.add(e.id);
  else {
    for (const e of facts.elements) if (e.status !== 'unchanged') keep.add(e.id);
    for (const e of facts.edges) {
      if (e.status === 'unchanged' || !byId.has(e.from) || !byId.has(e.to)) continue;
      keep.add(e.from);
      keep.add(e.to);
    }
  }
  // A folder that stands in for an element is not architecture. Next to a map or a workspace it is
  // left out ((root), test, .agents). With neither, a folder is drawn only when it holds changed
  // source or has a relationship: a folder of images is not a component.
  if (!opts.all) {
    const mapped = facts.elements.some((e) => e.source !== 'git');
    const linked = new Set(facts.edges.flatMap((e) => [e.from, e.to]));
    const coded = new Set(facts.files.filter((f) => f.language !== null && (f.kind === 'source' || f.kind === 'test')).map((f) => f.element));
    for (const id of [...keep]) {
      const e = byId.get(id)!;
      if (e.source === 'git' && (mapped || !(linked.has(id) || coded.has(id)))) keep.delete(id);
    }
  }
  for (const id of [...keep]) {
    for (let p = byId.get(id)?.parent; p && byId.has(p) && !keep.has(p); p = byId.get(p)?.parent) keep.add(p);
  }

  const elements: SpecElement[] = facts.elements.filter((e) => keep.has(e.id)).map((e) => ({
    id: e.id, type: e.type, name: e.name,
    ...(e.technology ? { technology: e.technology } : {}),
    description: e.description ?? `${e.files} ${e.files === 1 ? 'file' : 'files'} · ${e.filesChanged} changed`,
    ...(e.parent && keep.has(e.parent) ? { parent: e.parent } : {}),
    ...(e.external ? { external: true } : {}),
    status: e.status,
    meta: { files: e.files, filesChanged: e.filesChanged, dependentsAffected: e.dependentsAffected, provenance: e.provenance, source: e.source },
  }));
  // An element drawn as a group cannot have a line to a part of itself: the line would run from
  // the border of the group to a box inside it. Imports between a container and its own components stay in the facts.
  const inside = (id: string, group: string): boolean => {
    const seen = new Set<string>();
    for (let p = byId.get(id)?.parent; p && !seen.has(p); p = byId.get(p)?.parent) { if (p === group) return true; seen.add(p); }
    return false;
  };
  const relationships: SpecRelationship[] = facts.edges.filter((e) => keep.has(e.from) && keep.has(e.to) && !inside(e.from, e.to) && !inside(e.to, e.from)).map((e) => ({
    from: e.from, to: e.to, label: label(e),
    ...(e.technology ? { technology: e.technology } : {}),
    status: e.status,
    meta: { weight: e.weight, provenance: e.provenance, source: e.source },
  }));
  const short = (sha: string): string => (/^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 7) : sha.toLowerCase().replace('_', ' '));
  return {
    title: opts.title ?? `Change impact: ${short(facts.base)}..${short(facts.head)}`,
    type: elements.length && elements.every((e) => e.type === 'component') ? 'component' : 'container',
    elements,
    relationships,
  };
}
