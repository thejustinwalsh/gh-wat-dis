import type { DiagramSpec, SpecElement, SpecRelationship, SpecSymbol, Status } from '../spec.ts';
import type { Facts, SymbolFact } from './types.ts';

export interface CodeSpecOptions { title?: string; maxFiles?: number }
/** What the file-level spec left out, so the caller can say so. */
export interface CodeSpecResult { spec: DiagramSpec; drawn: number; changedLeftOut: string[]; dependentsLeftOut: string[] }

/** About five cards fit GitHub's width in one calm row. Eight is where a code diagram stops being read. */
export const MAX_FILES = 8;
const ROWS = 6;
/** A dependent that names more symbols of one file than this gets one line to the file. */
const LINES_PER_PAIR = 3;
const CHANGE: Record<string, Status> = { added: 'added', removed: 'removed', modified: 'changed' };
const short = (sha: string): string => (/^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 7) : sha.toLowerCase().replace('_', ' '));
const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * Facts as a code diagram: a card for each file whose symbols changed and for each file that imports one,
 * a row for each changed symbol, and a line from each importer to the symbol it names.
 * Files with changed exported symbols come first, then the files that import them, then the other
 * files with changed symbols, up to `maxFiles`. A changed file with no changed symbol (a page, a
 * manifest) is never drawn. What is left out is counted in the scope line and returned.
 */
export function toCodeSpec(facts: Facts, opts: CodeSpecOptions = {}): CodeSpecResult {
  const max = Math.max(1, opts.maxFiles ?? MAX_FILES);
  const symbols = new Map<string, SymbolFact[]>();
  for (const s of facts.symbols) symbols.set(s.file, [...(symbols.get(s.file) ?? []), s]);
  // uses: importer -> imported changed file -> the changed symbols it names.
  const uses = new Map<string, Map<string, Set<string>>>();
  const use = (from: string, to: string, name?: string): void => {
    if (from === to || !symbols.has(to)) return;
    const targets = uses.get(from) ?? uses.set(from, new Map()).get(from)!;
    const names = targets.get(to) ?? targets.set(to, new Set()).get(to)!;
    if (name !== undefined) names.add(name);
  };
  for (const s of facts.symbols) for (const d of s.dependents) use(d.file, s.file, s.name);
  for (const d of facts.dependents.direct) {
    for (const file of d.imports) {
      use(d.file, file);
      for (const name of d.symbols) if (symbols.get(file)?.some((s) => s.name === name)) use(d.file, file, name);
    }
  }
  const importers = (file: string): number => [...uses.values()].filter((t) => t.has(file)).length;
  const weight = (file: string): number => {
    const list = symbols.get(file)!;
    return list.filter((s) => s.exported && s.dependents.length).length * 100 + list.filter((s) => s.exported).length * 10 + list.length + importers(file) * 5;
  };
  const byWeight = (a: string, b: string): number => weight(b) - weight(a) || a.localeCompare(b);
  const withSymbols = [...symbols.keys()];
  const exported = withSymbols.filter((f) => symbols.get(f)!.some((s) => s.exported)).sort(byWeight);
  const inner = withSymbols.filter((f) => !exported.includes(f)).sort(byWeight);
  const tests = new Set([...facts.tests.changed, ...facts.tests.importingChanged]);

  const drawn: string[] = exported.slice(0, max);
  const reach = (file: string): number => [...(uses.get(file) ?? [])].filter(([to]) => drawn.includes(to)).reduce((n, [, names]) => n + 1 + names.size, 0);
  const candidates = [...uses.keys()].filter((f) => !drawn.includes(f) && reach(f) > 0)
    .sort((a, b) => Number(tests.has(a)) - Number(tests.has(b)) || reach(b) - reach(a) || a.localeCompare(b));
  const dependents = candidates.slice(0, Math.max(0, max - drawn.length));
  drawn.push(...dependents);
  drawn.push(...inner.filter((f) => !drawn.includes(f)).slice(0, Math.max(0, max - drawn.length)));

  const changed = new Map(facts.files.map((f) => [f.path, f]));
  const elementOf = (file: string): string | undefined =>
    changed.get(file)?.element ?? facts.dependents.direct.find((d) => d.file === file)?.element
    ?? facts.symbols.flatMap((s) => s.dependents).find((d) => d.file === file)?.element;
  const named = new Map(facts.elements.map((e) => [e.id, e.name]));
  const groups = new Map<string, string>();
  for (const file of drawn) {
    const id = elementOf(file);
    if (id !== undefined && named.has(id)) groups.set(file, id);
  }
  // One group for every file says nothing a title does not.
  const grouped = new Set(groups.values()).size > 1;
  const taken = new Set(drawn);
  const groupId = (id: string): string => { let g = `element:${id}`; while (taken.has(g)) g += '_'; return g; };

  const elements: SpecElement[] = [];
  if (grouped) for (const id of new Set(groups.values())) elements.push({ id: groupId(id), type: 'boundary', name: named.get(id)! });
  const rows = new Map<string, Set<string>>();
  for (const file of drawn) {
    const fact = changed.get(file);
    const list = [...(symbols.get(file) ?? [])].sort((a, b) =>
      Number(b.exported && b.dependents.length > 0) - Number(a.exported && a.dependents.length > 0) || Number(b.exported) - Number(a.exported) || a.name.localeCompare(b.name));
    const shown: SpecSymbol[] = list.slice(0, ROWS).map((s) => ({ name: s.name, kind: s.kind, status: CHANGE[s.change]! }));
    rows.set(file, new Set(shown.map((s) => s.name)));
    // A file outside the diff is affected when a symbol it names changed its signature or went away.
    const broken = !fact && [...(uses.get(file) ?? [])].some(([to, names]) =>
      symbols.get(to)!.some((s) => names.has(s.name) && (s.signatureChanged || s.change === 'removed')));
    const status: Status | undefined = fact ? (fact.status === 'added' ? 'added' : fact.status === 'deleted' ? 'removed' : 'changed') : broken ? 'affected' : undefined;
    const group = groups.get(file);
    elements.push({
      id: file, type: 'file', name: file,
      ...(status ? { status } : {}),
      ...(shown.length ? { symbols: shown } : {}),
      ...(list.length > ROWS ? { description: `and ${count(list.length - ROWS, 'more symbol')}` } : {}),
      ...(grouped && group !== undefined ? { parent: groupId(group) } : {}),
      meta: { inDiff: Boolean(fact), test: tests.has(file) },
    });
  }

  const relationships: SpecRelationship[] = [];
  for (const from of drawn) {
    for (const [to, names] of uses.get(from) ?? []) {
      if (!drawn.includes(to)) continue;
      const visible = [...names].filter((n) => rows.get(to)!.has(n)).sort();
      if (visible.length === 0 || visible.length > LINES_PER_PAIR || visible.length < names.size) relationships.push({ from, to, label: '' });
      else for (const toSymbol of visible) relationships.push({ from, to, label: '', toSymbol });
    }
  }

  const changedLeftOut = facts.files.map((f) => f.path).filter((f) => !drawn.includes(f)).sort();
  const dependentsLeftOut = [...uses.keys()].filter((f) => !drawn.includes(f) && !changed.has(f)).sort();
  const left = [
    ...(changedLeftOut.length ? [`${count(changedLeftOut.length, 'more changed file')}`] : []),
    ...(dependentsLeftOut.length ? [`${count(dependentsLeftOut.length, 'more importer')}`] : []),
  ];
  return {
    spec: {
      title: opts.title ?? `Changed code: ${short(facts.base)}..${short(facts.head)}`,
      type: 'code',
      scope: `${short(facts.base)}..${short(facts.head)}: ${count(drawn.length, 'file')} drawn${left.length ? `, ${left.join(' and ')} not drawn` : ''}`,
      direction: 'RIGHT',
      elements,
      relationships,
    },
    drawn: drawn.length, changedLeftOut, dependentsLeftOut,
  };
}
