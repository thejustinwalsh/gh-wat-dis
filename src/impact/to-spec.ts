import type { DiagramSpec, SpecElement, SpecRelationship } from '../spec.ts';
import type { EdgeFact, Facts, SpecOptions } from './types.ts';

function label(e: EdgeFact): string {
  if (e.label) return e.label;
  if (e.weight > 0) return `imports (${e.weight})`;
  return e.source === 'manifest' ? 'declares dependency' : 'imported on base (0 on head)';
}

/** Facts as a diagram spec. It does not prune or cap: the `graph` tool reshapes specs. */
export function toDiagramSpec(facts: Facts, opts: SpecOptions = {}): DiagramSpec {
  const byId = new Map(facts.elements.map((e) => [e.id, e]));
  const keep = new Set<string>();
  if (opts.all) for (const e of facts.elements) keep.add(e.id);
  else {
    const core = new Set(facts.elements.filter((e) => e.status === 'changed' || e.status === 'added' || e.status === 'removed').map((e) => e.id));
    for (const id of core) keep.add(id);
    for (const e of facts.edges) {
      if (core.has(e.from) && byId.has(e.to)) keep.add(e.to);
      if (core.has(e.to) && byId.has(e.from)) keep.add(e.from);
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
  const relationships: SpecRelationship[] = facts.edges.filter((e) => keep.has(e.from) && keep.has(e.to)).map((e) => ({
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
