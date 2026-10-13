import { UsageError } from '../cli/util.ts';
import { STATUSES } from '../spec.ts';
import type { DiagramSpec, SpecElement, Status } from '../spec.ts';

export const list = (s: string | undefined): string[] => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

export const statusOf = (x: { status?: Status }): Status => x.status ?? 'unchanged';

export const byId = (spec: DiagramSpec): Map<string, SpecElement> => new Map(spec.elements.map((e) => [e.id, e]));

export function requireIds(spec: DiagramSpec, ids: string[]): void {
  const known = byId(spec);
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) throw new UsageError(`unknown element id: ${missing.join(', ')} (list ids with \`graph ids\`)`);
}

export function requireOneOf(values: string[], allowed: readonly string[], what: string): void {
  const bad = values.filter((v) => !allowed.includes(v));
  if (bad.length) throw new UsageError(`unknown ${what}: ${bad.join(', ')} (one of ${allowed.join(', ')})`);
}

/** Ids of everything nested under `id`, at any depth. */
export function descendants(spec: DiagramSpec, id: string): string[] {
  const out: string[] = [];
  const seen = new Set([id]);
  for (let frontier = [id]; frontier.length;) {
    frontier = spec.elements.filter((e) => e.parent !== undefined && frontier.includes(e.parent) && !seen.has(e.id)).map((e) => e.id);
    for (const f of frontier) { seen.add(f); out.push(f); }
  }
  return out;
}

/** The parent chain of `id`, nearest first. */
export function ancestors(spec: DiagramSpec, id: string): string[] {
  const known = byId(spec);
  const out: string[] = [];
  for (let p = known.get(id)?.parent; p !== undefined && known.has(p) && !out.includes(p) && p !== id; p = known.get(p)!.parent) out.push(p);
  return out;
}

/**
 * Resolve `a,b` to those ids, or `status:changed,added` to every element with one of those statuses
 * plus both ends of every relationship with one of them.
 */
export function select(spec: DiagramSpec, selector: string): string[] {
  if (!selector.startsWith('status:')) {
    const ids = list(selector);
    requireIds(spec, ids);
    return ids;
  }
  const statuses = list(selector.slice('status:'.length));
  requireOneOf(statuses, STATUSES, 'status');
  const ids = new Set(spec.elements.filter((e) => statuses.includes(statusOf(e))).map((e) => e.id));
  for (const r of spec.relationships) if (statuses.includes(statusOf(r))) { ids.add(r.from); ids.add(r.to); }
  return spec.elements.filter((e) => ids.has(e.id)).map((e) => e.id);
}

const STRENGTH: Status[] = ['removed', 'added', 'changed', 'affected', 'unchanged'];

/**
 * The status of several things shown as one. All the same: that status. Otherwise the strongest,
 * except that a mix is never `removed` or `added`: part of the whole is still there, so it is `changed`.
 */
export function mergeStatus(statuses: Status[]): Status {
  const distinct = [...new Set(statuses)];
  if (distinct.length <= 1) return distinct[0] ?? 'unchanged';
  const top = STRENGTH.find((s) => distinct.includes(s))!;
  return top === 'removed' || top === 'added' ? 'changed' : top;
}
