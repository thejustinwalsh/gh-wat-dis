import { UsageError } from '../cli/util.ts';
import { DIAGRAM_TYPES, ELEMENT_TYPES, STATUSES } from '../spec.ts';
import type { DiagramSpec, DiagramType, SpecElement, SpecRelationship, Status } from '../spec.ts';
import { ancestors, byId, descendants, mergeStatus, requireIds, requireOneOf, statusOf } from './select.ts';

const withStatus = <T extends { status?: Status }>(item: T, status: Status): T => {
  const { status: _old, ...rest } = item;
  return (status === 'unchanged' && item.status === undefined ? rest : { ...rest, status }) as T;
};

/** Drop relationships and parents that point at elements that are no longer there. */
function clean(spec: DiagramSpec): DiagramSpec {
  const ids = new Set(spec.elements.map((e) => e.id));
  return {
    ...spec,
    elements: spec.elements.map((e) => {
      if (e.parent === undefined || (ids.has(e.parent) && e.parent !== e.id)) return e;
      const { parent: _gone, ...rest } = e;
      return rest;
    }),
    relationships: spec.relationships.filter((r) => ids.has(r.from) && ids.has(r.to)),
  };
}

const keep = (spec: DiagramSpec, ids: Set<string>): DiagramSpec =>
  clean({ ...spec, elements: spec.elements.filter((e) => ids.has(e.id)) });

export interface FocusOptions { on: string[]; hops?: number; direction?: 'both' | 'in' | 'out' }

/** Keep the named elements (and what they contain), neighbours within `hops`, and every ancestor of a kept element. */
export function focus(spec: DiagramSpec, opts: FocusOptions): DiagramSpec {
  requireIds(spec, opts.on);
  const direction = opts.direction ?? 'both';
  const kept = new Set(opts.on.flatMap((id) => [id, ...descendants(spec, id)]));
  let frontier = [...kept];
  for (let hop = 0; hop < (opts.hops ?? 1) && frontier.length; hop++) {
    const next: string[] = [];
    for (const r of spec.relationships) {
      if (direction !== 'in' && frontier.includes(r.from) && !kept.has(r.to)) { kept.add(r.to); next.push(r.to); }
      if (direction !== 'out' && frontier.includes(r.to) && !kept.has(r.from)) { kept.add(r.from); next.push(r.from); }
    }
    frontier = next;
  }
  for (const id of [...kept]) for (const a of ancestors(spec, id)) kept.add(a);
  return keep(spec, kept);
}

export interface CollapseOptions { into?: string[]; toType?: string }

function mergeParallel(group: SpecRelationship[]): SpecRelationship {
  const first = group[0]!;
  if (group.length === 1) return first;
  const distinct = (values: (string | undefined)[]): string[] => [...new Set(values.filter((v): v is string => !!v))];
  const technology = distinct(group.map((r) => r.technology)).join(', ');
  const { technology: _t, order: _o, ...rest } = first;
  return withStatus({
    ...rest,
    label: distinct(group.map((r) => r.label)).join('; '),
    ...(technology ? { technology } : {}),
    meta: { ...first.meta, merged: group.length },
  }, mergeStatus(group.map(statusOf)));
}

/** Replace everything inside the matching elements by the element itself. */
export function collapse(spec: DiagramSpec, opts: CollapseOptions): DiagramSpec {
  requireIds(spec, opts.into ?? []);
  if (opts.toType !== undefined) requireOneOf([opts.toType], ELEMENT_TYPES, 'element type');
  const targets = spec.elements.filter((e) => opts.into?.includes(e.id) || e.type === opts.toType);
  const into = new Map<string, string>();
  const inside = new Map<string, SpecElement[]>();
  const known = byId(spec);
  // Outermost target wins: skip a target that sits inside another target.
  for (const t of targets) {
    if (ancestors(spec, t.id).some((a) => targets.some((x) => x.id === a))) continue;
    const gone = descendants(spec, t.id);
    if (!gone.length) continue;
    for (const id of gone) into.set(id, t.id);
    inside.set(t.id, gone.map((id) => known.get(id)!));
  }
  const elements = spec.elements.filter((e) => !into.has(e.id)).map((e) => {
    const gone = inside.get(e.id);
    if (!gone) return e;
    const status = mergeStatus([e, ...gone].map(statusOf));
    return withStatus({ ...e, meta: { ...e.meta, collapsed: gone.length } }, status);
  });
  const groups = new Map<string, { moved: boolean; rels: SpecRelationship[] }>();
  for (const r of spec.relationships) {
    const from = into.get(r.from) ?? r.from, to = into.get(r.to) ?? r.to;
    const moved = from !== r.from || to !== r.to;
    if (moved && from === to) continue;
    // Only relationships that were re-pointed merge; parallels the author drew stay apart.
    const key = moved ? JSON.stringify([from, to]) : `as-is ${groups.size}`;
    const group = groups.get(key) ?? { moved, rels: [] };
    group.rels.push(moved ? { ...r, from, to } : r);
    groups.set(key, group);
  }
  return clean({ ...spec, elements, relationships: [...groups.values()].map((g) => mergeParallel(g.rels)) });
}

export interface DropOptions { ids?: string[]; status?: string[]; type?: string[]; external?: boolean; orphans?: boolean }

/** Remove elements and their relationships. `orphans` runs last, on what the other filters left. */
export function drop(spec: DiagramSpec, opts: DropOptions): DiagramSpec {
  requireIds(spec, opts.ids ?? []);
  requireOneOf(opts.status ?? [], STATUSES, 'status');
  requireOneOf(opts.type ?? [], ELEMENT_TYPES, 'element type');
  const gone = (e: SpecElement): boolean =>
    !!opts.ids?.includes(e.id) || !!opts.status?.includes(statusOf(e)) || !!opts.type?.includes(e.type)
    || (!!opts.external && e.external === true);
  let out = clean({ ...spec, elements: spec.elements.filter((e) => !gone(e)) });
  while (opts.orphans) {
    const busy = new Set(out.relationships.flatMap((r) => [r.from, r.to]));
    for (const e of out.elements) if (e.parent !== undefined) busy.add(e.parent);
    const rest = out.elements.filter((e) => busy.has(e.id));
    if (rest.length === out.elements.length) break;
    out = clean({ ...out, elements: rest });
  }
  return out;
}

/** Union by element id and by relationship (from, to, label). Later specs win field by field. */
export function merge(specs: DiagramSpec[]): DiagramSpec {
  const first = specs[0];
  if (!first) throw new UsageError('merge needs at least one spec');
  const elements = new Map<string, SpecElement>();
  const relationships = new Map<string, SpecRelationship>();
  for (const spec of specs) {
    for (const e of spec.elements) elements.set(e.id, { ...elements.get(e.id), ...e });
    for (const r of spec.relationships) {
      const key = JSON.stringify([r.from, r.to, r.label]);
      relationships.set(key, { ...relationships.get(key), ...r });
    }
  }
  const scope = specs.find((s) => s.scope !== undefined)?.scope;
  const direction = specs.find((s) => s.direction !== undefined)?.direction;
  return clean({
    title: first.title,
    type: first.type,
    ...(scope !== undefined ? { scope } : {}),
    ...(direction !== undefined ? { direction } : {}),
    elements: [...elements.values()],
    relationships: [...relationships.values()],
  });
}

const ELEMENT_FIELDS = ['name', 'type', 'technology', 'description', 'parent', 'external'] as const;

/** One spec that shows what changed from `base` to `head`. Removed things stay in, marked `removed`. */
export function diff(base: DiagramSpec, head: DiagramSpec): DiagramSpec {
  const was = byId(base), now = byId(head);
  const mark = <T extends { status?: Status }>(item: T, status: Status): T => {
    const { status: _old, ...rest } = item;
    return (status === 'unchanged' ? rest : { ...rest, status }) as T;
  };
  const elements = [
    ...head.elements.map((e) => {
      const old = was.get(e.id);
      if (!old) return mark(e, 'added');
      return mark(e, ELEMENT_FIELDS.some((f) => old[f] !== e[f]) ? 'changed' : 'unchanged');
    }),
    ...base.elements.filter((e) => !now.has(e.id)).map((e) => mark(e, 'removed')),
  ];
  const key = (r: SpecRelationship): string => JSON.stringify([r.from, r.to]);
  const oldRels = new Map(base.relationships.map((r) => [key(r), r]));
  const newKeys = new Set(head.relationships.map(key));
  const relationships = [
    ...head.relationships.map((r) => {
      const old = oldRels.get(key(r));
      if (!old) return mark(r, 'added');
      return mark(r, old.label !== r.label || old.technology !== r.technology ? 'changed' : 'unchanged');
    }),
    ...base.relationships.filter((r) => !newKeys.has(key(r))).map((r) => mark(r, 'removed')),
  ];
  return clean({ ...head, elements, relationships });
}

export interface SetOptions {
  title?: string; type?: string; scope?: string; direction?: string;
  element?: string;
  /** `from:to` */
  relationship?: string;
  /** Field edits for the element or relationship. An empty value deletes the field. */
  fields?: Record<string, string>;
}

function edit<T extends object>(item: T, fields: Record<string, string>, allowed: Record<string, (v: string) => unknown>, required: string[]): T {
  const out: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  for (const [k, v] of Object.entries(fields)) {
    const parse = allowed[k];
    if (!parse) throw new UsageError(`cannot set "${k}" (one of ${Object.keys(allowed).join(', ')})`);
    if (v !== '') out[k] = parse(v);
    else if (required.includes(k)) throw new UsageError(`"${k}" is required and cannot be deleted`);
    else delete out[k];
  }
  return out as T;
}

const oneOf = (allowed: readonly string[], what: string) => (v: string): string => {
  requireOneOf([v], allowed, what);
  return v;
};
const bool = (v: string): boolean => {
  if (v !== 'true' && v !== 'false') throw new UsageError(`expected true or false, got "${v}"`);
  return v === 'true';
};
const num = (v: string): number => {
  if (!Number.isFinite(Number(v))) throw new UsageError(`expected a number, got "${v}"`);
  return Number(v);
};
const str = (v: string): string => v;

/** Edit top-level fields, one element, or the relationships between two elements. */
export function set(spec: DiagramSpec, opts: SetOptions): DiagramSpec {
  const out: DiagramSpec = { ...spec };
  if (opts.title !== undefined) out.title = opts.title;
  if (opts.type !== undefined) out.type = oneOf(DIAGRAM_TYPES, 'diagram type')(opts.type) as DiagramType;
  if (opts.scope !== undefined) { if (opts.scope) out.scope = opts.scope; else delete out.scope; }
  if (opts.direction !== undefined) {
    if (opts.direction) out.direction = oneOf(['DOWN', 'RIGHT'], 'direction')(opts.direction) as 'DOWN' | 'RIGHT';
    else delete out.direction;
  }
  const fields = opts.fields ?? {};
  if (opts.element !== undefined) {
    const id = opts.element;
    requireIds(spec, [id]);
    const parent = (v: string): string => {
      requireIds(spec, [v]);
      if (v === id || descendants(spec, id).includes(v)) throw new UsageError(`"${v}" cannot be the parent of "${id}": that is a cycle`);
      return v;
    };
    const allowed = {
      name: str, type: oneOf(ELEMENT_TYPES, 'element type'), technology: str, description: str,
      parent, external: bool, status: oneOf(STATUSES, 'status'),
    };
    out.elements = spec.elements.map((e) => (e.id === id ? edit(e, fields, allowed, ['name', 'type']) : e));
  }
  if (opts.relationship !== undefined) {
    const pair = opts.relationship;
    const hit = (r: SpecRelationship): boolean => `${r.from}:${r.to}` === pair;
    if (!spec.relationships.some(hit)) throw new UsageError(`no relationship ${pair} (write it as from:to)`);
    const allowed = { label: str, technology: str, status: oneOf(STATUSES, 'status'), order: num };
    out.relationships = spec.relationships.map((r) => (hit(r) ? edit(r, fields, allowed, ['label']) : r));
  }
  if (opts.element === undefined && opts.relationship === undefined && Object.keys(fields).length) {
    throw new UsageError('key=value edits need --element <id> or --relationship <from>:<to>');
  }
  return out;
}

export function rename(spec: DiagramSpec, opts: { from: string; to: string }): DiagramSpec {
  requireIds(spec, [opts.from]);
  if (!opts.to) throw new UsageError('the new id is empty');
  if (opts.to !== opts.from && byId(spec).has(opts.to)) throw new UsageError(`id "${opts.to}" is already used`);
  const swap = (id: string): string => (id === opts.from ? opts.to : id);
  return {
    ...spec,
    elements: spec.elements.map((e) => ({ ...e, id: swap(e.id), ...(e.parent !== undefined ? { parent: swap(e.parent) } : {}) })),
    relationships: spec.relationships.map((r) => ({ ...r, from: swap(r.from), to: swap(r.to) })),
  };
}

export interface Stats {
  elements: number;
  relationships: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  /** Nesting levels: 1 when nothing has a parent. */
  maxDepth: number;
  roots: number;
}

export function stats(spec: DiagramSpec): Stats {
  const count = (keys: string[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const k of keys) out[k] = (out[k] ?? 0) + 1;
    return out;
  };
  const known = byId(spec);
  return {
    elements: spec.elements.length,
    relationships: spec.relationships.length,
    byType: count(spec.elements.map((e) => e.type)),
    byStatus: count(spec.elements.map(statusOf)),
    maxDepth: Math.max(0, ...spec.elements.map((e) => ancestors(spec, e.id).length + 1)),
    roots: spec.elements.filter((e) => e.parent === undefined || !known.has(e.parent)).length,
  };
}

/** One line per element: id, type, status, name, separated by tabs. */
export const ids = (spec: DiagramSpec): string =>
  spec.elements.map((e) => `${[e.id, e.type, statusOf(e), e.name].join('\t')}\n`).join('');
