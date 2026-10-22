import type { DiagramSpec, SpecElement, SpecRelationship } from '../spec.ts';
import { BREADTH_BUDGET, BUDGET, load } from '../diagram/budget.ts';
import { codeShape } from '../diagram/code-shape.ts';
import type { EdgeFact, Facts, PartFact, SpecOptions } from './types.ts';

/**
 * A generated line says what moves across it as far as the tools saw it: the names one element imports from the
 * other, read from the imports of the files around the change. Where no file near the change imports across it, the
 * tools know only that code is imported. The author relabels the line with what it does.
 */
function label(e: EdgeFact, names: string[]): string {
  if (e.label) return e.label;
  if (e.source === 'manifest' && !e.weight) return 'Declares a dependency on';
  const verb = e.weight > 0 ? 'Imports' : 'Imported';
  if (!names.length) return `${verb} code from`;
  const shown = names.slice(0, 2).join(names.length === 2 ? ' and ' : ', ');
  return `${verb} ${shown}${names.length > 2 ? ` and ${names.length - 2} more` : ''} from`;
}
/** How many files import across the relationship, where the map names no technology. */
const technology = (e: EdgeFact): string | undefined => e.technology ?? (e.label ? undefined : e.weight > 0 ? `${e.weight} ${e.weight === 1 ? 'import' : 'imports'}` : e.source === 'manifest' ? 'package manifest' : undefined);

/** A part the change added or removed is a box of its own; past this many, the scope line counts the rest. */
const MAX_PARTS = 6;
const PART_WORDS: Record<PartFact['kind'], string> = { command: 'Command', tool: 'Tool', skill: 'Agent skill', route: 'HTTP route', job: 'Scheduled job', bin: 'Executable', export: 'Package entry', option: 'Option' };
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Past its budget an element diagram is a hairball: the affected elements are cut to the most reached, and the unchanged lines to the heaviest. */
const MAX_ELEMENTS = BUDGET.container.boxes;
const MAX_LINES = BUDGET.container.lines;

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
  let cut = 0;
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
    // An end of a relationship the change added or removed stays, mapped or not: it is why the picture is drawn.
    const ends = new Set(facts.edges.filter((e) => e.status !== 'unchanged').flatMap((e) => [e.from, e.to]));
    const before = new Set(keep);
    for (const id of [...keep]) {
      const e = byId.get(id)!;
      if (e.source === 'git' && !ends.has(id) && (mapped || !(linked.has(id) || coded.has(id)))) keep.delete(id);
    }
    // With no map and no workspace, folders are all there is. A change that touches source is never "no changed elements".
    if (!keep.size && coded.size) for (const id of before) if (coded.has(id)) keep.add(id);
  }
  // Each part the change added or removed is drawn inside the element that holds it, with a line from what calls it.
  // An option is not a box: it is drawn as the code of its command, at the file level.
  const parts = (facts.parts ?? []).filter((p) => p.kind !== 'option' && byId.has(p.element));
  const shownParts = parts.slice(0, MAX_PARTS);
  for (const p of shownParts) {
    keep.add(p.element);
    if (p.calledBy && byId.has(p.calledBy.element)) keep.add(p.calledBy.element);
  }
  for (const id of [...keep]) {
    for (let p = byId.get(id)?.parent; p && byId.has(p) && !keep.has(p); p = byId.get(p)?.parent) keep.add(p);
  }

  let elements: SpecElement[] = facts.elements.filter((e) => keep.has(e.id)).map((e) => ({
    id: e.id, type: e.type, name: e.name,
    // An element found as a folder, with no map and no manifest, has no technology to name. It says it is a folder.
    ...(e.technology ? { technology: e.technology } : e.source === 'git' ? { technology: 'folder' } : {}),
    description: [e.renamedFrom ? `renamed from ${e.renamedFrom}` : '', e.description ?? `${e.files} ${e.files === 1 ? 'file' : 'files'} · ${e.filesChanged} changed`].filter(Boolean).join(' · '),
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
  const edges = facts.edges.filter((e) => keep.has(e.from) && keep.has(e.to) && !inside(e.from, e.to) && !inside(e.to, e.from));
  // The names each element imports from another, as the facts list them for the files around the change.
  const elementOf = new Map<string, string>(facts.files.map((f) => [f.path, f.element]));
  for (const d of facts.dependents.direct) elementOf.set(d.file, d.element);
  const moved = new Map<string, Set<string>>();
  for (const i of facts.imports) {
    const from = elementOf.get(i.from);
    if (from === undefined || from === i.toElement || i.change === 'removed') continue;
    const key = `${from}\0${i.toElement}`;
    for (const n of i.names) (moved.get(key) ?? moved.set(key, new Set()).get(key)!).add(n);
  }
  let relationships: SpecRelationship[] = edges.map((e) => ({
    from: e.from, to: e.to, label: label(e, [...(moved.get(`${e.from}\0${e.to}`) ?? [])].sort()),
    ...(technology(e) ? { technology: technology(e)! } : {}),
    status: e.status,
    meta: { weight: e.weight, provenance: e.provenance, source: e.source },
  }));
  const partIds = new Map(shownParts.map((p) => [p, `part-${p.kind}-${slug(p.name)}`]));
  for (const [p, id] of partIds) {
    elements.push({
      id, type: 'component', name: p.name, technology: PART_WORDS[p.kind],
      description: `Found in ${p.basis}`,
      parent: p.element, status: p.change,
      meta: { files: 0, filesChanged: 0, dependentsAffected: 0, provenance: p.provenance, source: p.source, part: p.kind },
    });
    const by = p.calledBy;
    if (by && keep.has(by.element) && !inside(by.element, p.element) && by.element !== p.element) {
      relationships.push({
        from: by.element, to: id, label: `${by.label} ${p.name}`, ...(by.technology ? { technology: by.technology } : {}), status: p.change,
        meta: { weight: 0, provenance: by.provenance, source: by.source },
      });
    }
  }
  // Changed relationships and named parts explain the change, so their endpoints stay even when affected.
  const required = new Set([
    ...facts.elements.filter((e) => ['added', 'removed', 'changed'].includes(e.status)).map((e) => e.id),
    ...facts.edges.filter((e) => e.status !== 'unchanged').flatMap((e) => [e.from, e.to]),
    ...shownParts.flatMap((p) => [p.element, ...(p.calledBy ? [p.calledBy.element] : [])]),
  ]);
  for (const id of [...required]) {
    for (let p = byId.get(id)?.parent; p && byId.has(p) && !required.has(p); p = byId.get(p)?.parent) required.add(p);
  }
  const picture = (): DiagramSpec => ({ title: '', type: 'container', elements, relationships });
  if (!opts.all) {
    // A hub can fit the box count and still put eleven dependents at one step. Measure the same layers as
    // the renderer, including named parts and their callers, and remove the least reached context first.
    // Named parts use the same space as affected context. Reserve their cards before selecting at most
    // four affected elements across the picture, so groups of parts do not make a shallow graph too tall.
    // Recompute after each cut: taking a package out can move another package to a different layer.
    for (;;) {
      const shape = codeShape(picture(), undefined, Infinity, false);
      const counts = new Map<number, number>();
      for (const layer of shape.layer.values()) counts.set(layer, (counts.get(layer) ?? 0) + 1);
      const wide = new Set([...counts].filter(([, count]) => count > BREADTH_BUDGET).map(([layer]) => layer));
      const full = load(picture()).boxes > MAX_ELEMENTS;
      const context = elements.filter((e) => e.status === 'affected' && !required.has(e.id));
      const crowded = context.length > Math.max(0, BREADTH_BUDGET - shownParts.length);
      if (!full && !wide.size && !crowded) break;
      const parents = new Set(elements.map((e) => e.parent));
      const candidates = elements.filter((e) => e.status === 'affected' && !required.has(e.id) && !parents.has(e.id)
        && (full || crowded || wide.has(shape.layer.get(e.id)!)));
      candidates.sort((a, b) => byId.get(a.id)!.dependentsAffected - byId.get(b.id)!.dependentsAffected || b.id.localeCompare(a.id));
      const gone = candidates[0];
      // The change itself may exceed the budget. Keep its elements and relationships for the author to scope.
      if (!gone) break;
      elements = elements.filter((e) => e.id !== gone.id);
      relationships = relationships.filter((r) => r.from !== gone.id && r.to !== gone.id);
      cut++;
    }
  }
  // Every relationship the change added or removed is drawn. The unchanged ones fill what room is left:
  // those that touch a changed element first, then the ones the most files import across.
  let cutLines = 0;
  if (!opts.all && relationships.length > MAX_LINES) {
    const touched = (r: SpecRelationship): number => Number(['added', 'removed', 'changed'].includes(byId.get(r.from)?.status ?? '')) + Number(['added', 'removed', 'changed'].includes(byId.get(r.to)?.status ?? ''));
    const weight = new Map(edges.map((e) => [`${e.from}\0${e.to}`, e.weight]));
    const calm = relationships.filter((r) => r.status === 'unchanged').sort((a, b) => touched(b) - touched(a) || (weight.get(`${b.from}\0${b.to}`) ?? 0) - (weight.get(`${a.from}\0${a.to}`) ?? 0) || `${a.from} ${a.to}`.localeCompare(`${b.from} ${b.to}`));
    const gone = new Set(calm.slice(Math.max(0, MAX_LINES - (relationships.length - calm.length))));
    cutLines = gone.size;
    relationships = relationships.filter((r) => !gone.has(r));
  }
  const partsLeft = parts.length - shownParts.length;
  const left = [
    ...(partsLeft ? [`${partsLeft} more added or removed ${partsLeft === 1 ? 'part is' : 'parts are'} not drawn`] : []),
    ...(cut ? [`${cut} more affected ${cut === 1 ? 'element is' : 'elements are'} not drawn`] : []),
    ...(cutLines ? [`${cutLines} unchanged ${cutLines === 1 ? 'relationship is' : 'relationships are'} not drawn`] : []),
    ...(elements.some((e) => e.meta?.source === 'git' && !e.meta?.part) ? ['folder names follow repository paths'] : []),
  ];
  const short = (sha: string): string => (/^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 7) : sha.toLowerCase().replace('_', ' '));
  return {
    title: opts.title ?? `Change impact: ${short(facts.base)}..${short(facts.head)}`,
    type: elements.length && elements.every((e) => e.type === 'component') ? 'component' : 'container',
    ...(left.length ? { scope: `the change and ${cut ? 'the elements it reaches most' : 'what it reaches'}; ${left.join(', ')}` } : {}),
    elements,
    relationships,
  };
}
