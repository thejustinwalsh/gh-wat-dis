import type { DiagramSpec, SpecElement, SpecRelationship, SpecSymbol, Status } from '../spec.ts';
import type { Facts, FileFact, SymbolFact } from './types.ts';

export interface CodeSpecOptions { title?: string; maxFiles?: number }
/** What the file-level spec left out, so the caller can say so. */
export interface CodeSpecResult {
  spec: DiagramSpec;
  drawn: number;
  /** Changed source files that got no card, largest change first. */
  changedLeftOut: string[];
  /** Files that import a changed symbol and got no card. */
  dependentsLeftOut: string[];
  /** Changed source files that were not parsed, with the reason. Drawn or not, their symbols are unknown. */
  notRead: { path: string; reason: string }[];
}

/** About five cards fit GitHub's width in one calm row. Eight is where a code diagram stops being read. */
export const MAX_FILES = 8;
const ROWS = 6;
/** A file gets at most this many rows for names that another file newly imports from it. */
const IMPORT_ROWS = 3;
/** Slots kept for files outside the diff: the ones that import a changed symbol, and the ones a changed file newly imports. */
const CONTEXT_SLOTS = 2;
const CHANGE: Record<string, Status> = { added: 'added', removed: 'removed', modified: 'changed' };
const short = (sha: string): string => (/^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 7) : sha.toLowerCase().replace('_', ' '));
const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const base = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const delta = (f: FileFact): string => [f.insertions ? `+${f.insertions}` : '', f.deletions ? `−${f.deletions}` : ''].filter(Boolean).join(' ') || '0 lines';
const FIXTURE = /(^|\/)(fixtures?|__fixtures__|__mocks__|golden|testdata|snapshots?)(\/|\.)|\.snap$/;
const CONFIG = /(^|\/)[^/]*\.config\.[cm]?[jt]s$/;

/**
 * Facts as a code diagram. A card for each changed source file, largest change first, then for the
 * files outside the diff that the change touches: files that import a changed symbol by name, and
 * files a changed file newly imports. A row for each symbol the change added, changed or removed,
 * the most changed first.
 *
 * Only what the source proves is drawn. A line ends on a symbol row when the importer names that
 * symbol. An import of the whole module (a namespace, a dynamic import, a class whose method
 * changed) ends on the file. A line for an import the change added carries the added mark.
 * A changed file that is not source in a parsed language (a page, a manifest) is never drawn.
 * What is left out is named in the scope line and returned.
 */
export function toCodeSpec(facts: Facts, opts: CodeSpecOptions = {}): CodeSpecResult {
  const max = Math.max(1, opts.maxFiles ?? MAX_FILES);
  const changed = new Map(facts.files.map((f) => [f.path, f]));
  const symbols = new Map<string, SymbolFact[]>();
  for (const s of facts.symbols) symbols.set(s.file, [...(symbols.get(s.file) ?? []), s]);
  const rise = new Map<string, number>();
  for (const c of facts.complexity) {
    const key = `${c.file}\0${c.name.split(' > ')[0]}`;
    rise.set(key, (rise.get(key) ?? 0) + Math.abs((c.after?.cognitive ?? 0) - (c.before?.cognitive ?? 0)));
  }
  const amount = (s: SymbolFact): number => s.lines + 3 * (rise.get(`${s.file}\0${s.name}`) ?? 0);
  const tests = new Set([...facts.tests.changed, ...facts.tests.importingChanged]);

  // Which changed files get a card: source in a parsed language, by how much of it changed.
  // A list of re-exports, a fixture or a build config holds little of a change, so it ranks low.
  const isCode = (f: FileFact): boolean => f.language !== null && (f.kind === 'source' || f.kind === 'test') && !f.binary;
  const barrel = (path: string): boolean => (symbols.get(path) ?? []).length > 0 && symbols.get(path)!.every((s) => s.kind === 'reexport');
  const weight = (f: FileFact): number => {
    const own = f.insertions + f.deletions + 3 * [...rise].filter(([k]) => k.startsWith(`${f.path}\0`)).reduce((n, [, v]) => n + v, 0);
    return own * (barrel(f.path) ? 0.15 : 1) * (FIXTURE.test(f.path) ? 0.25 : tests.has(f.path) ? 0.5 : 1) * (CONFIG.test(f.path) ? 0.25 : 1);
  };
  const code = facts.files.filter(isCode)
    // A file that only moved has nothing to show on a card. The scope line counts the moves.
    .filter((f) => symbols.has(f.path) || f.skipped !== undefined || f.insertions + f.deletions > 0)
    .sort((a, b) => weight(b) - weight(a) || a.path.localeCompare(b.path));

  // Lines. `uses`: an importer names a changed symbol (proven), or imports the whole module (the file is all that is known).
  type Use = { names: Set<string>; whole: boolean; added: Set<string>; removed: Set<string>; fresh: boolean; gone: boolean };
  const uses = new Map<string, Map<string, Use>>();
  const use = (from: string, to: string): Use => {
    const targets = uses.get(from) ?? uses.set(from, new Map()).get(from)!;
    return targets.get(to) ?? targets.set(to, { names: new Set(), whole: false, added: new Set(), removed: new Set(), fresh: false, gone: false }).get(to)!;
  };
  for (const s of facts.symbols) {
    for (const d of s.dependents) {
      if (d.file === s.file) continue;
      if (d.provenance === 'resolved') use(d.file, s.file).names.add(s.name); else use(d.file, s.file).whole = true;
    }
  }
  for (const d of facts.dependents.direct) {
    for (const file of d.imports) {
      const u = use(d.file, file);
      const mine = d.symbols.filter((name) => symbols.get(file)?.some((s) => s.name === name));
      for (const name of mine) u.names.add(name);
      if (!mine.length) u.whole = true;
    }
  }
  for (const i of facts.imports) {
    const u = use(i.from, i.to);
    for (const name of i.names) (i.change === 'added' ? u.added : u.removed).add(name);
    if (i.change === 'added' && (i.whole || !i.names.length)) { u.fresh = true; u.whole = true; }
    if (i.change === 'removed' && (i.whole || !i.names.length)) u.gone = true;
  }

  // Slots: changed files first, with a few kept for the files around them.
  const importsChanged = (file: string): number => [...(uses.get(file) ?? [])].filter(([to, u]) => changed.has(to) && symbols.has(to) && (u.names.size > 0 || u.whole)).reduce((n, [, u]) => n + 1 + 2 * u.names.size, 0);
  const importers = [...uses.keys()].filter((f) => !changed.has(f) && importsChanged(f) > 0)
    .sort((a, b) => Number(tests.has(a)) - Number(tests.has(b)) || importsChanged(b) - importsChanged(a) || a.localeCompare(b));
  // A file outside the diff that a modified file starts to import by name. An added file imports everything anew, so it does not count here.
  const newlyImported = new Map<string, number>();
  for (const i of facts.imports) {
    if (i.change !== 'added' || i.toInDiff || !i.names.length || changed.get(i.from)?.status === 'added') continue;
    newlyImported.set(i.to, (newlyImported.get(i.to) ?? 0) + i.names.length);
  }
  const context = [...new Set([...[...newlyImported.keys()].sort((a, b) => newlyImported.get(b)! - newlyImported.get(a)! || a.localeCompare(b)), ...importers])];
  const kept = Math.min(context.length, CONTEXT_SLOTS, max - 1);
  const drawn: string[] = code.slice(0, Math.max(1, max - kept)).map((f) => f.path);
  const around = context.filter((f) => [...(uses.get(f) ?? [])].some(([to]) => drawn.includes(to)) || drawn.some((d) => uses.get(d)?.has(f)));
  drawn.push(...around.slice(0, Math.max(0, max - drawn.length)));
  drawn.push(...code.map((f) => f.path).filter((f) => !drawn.includes(f)).slice(0, Math.max(0, max - drawn.length)));

  // Groups: the elements of the architecture map, or of the workspace. A top-level folder is not an architecture element.
  const elementOf = (file: string): string | undefined =>
    changed.get(file)?.element ?? facts.dependents.direct.find((d) => d.file === file)?.element
    ?? facts.symbols.flatMap((s) => s.dependents).find((d) => d.file === file)?.element ?? facts.imports.find((i) => i.to === file)?.toElement;
  const named = new Map(facts.elements.filter((e) => e.source !== 'git').map((e) => [e.id, e.name]));
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
      Number(a.kind === 'reexport') - Number(b.kind === 'reexport') || amount(b) - amount(a) || a.name.localeCompare(b.name));
    const shown: SpecSymbol[] = list.slice(0, ROWS).map((s) => ({ name: s.name, kind: s.kind, status: CHANGE[s.change]! }));
    // A name that another drawn file newly imports from this one gets a row with no mark, so the line has a row to end on.
    const wanted = new Set<string>();
    for (const from of drawn) for (const name of uses.get(from)?.get(file)?.added ?? []) if (!list.some((s) => s.name === name)) wanted.add(name);
    for (const name of [...wanted].sort().slice(0, IMPORT_ROWS)) shown.push({ name });
    rows.set(file, new Set(shown.map((s) => s.name)));
    // A file outside the diff is affected when a symbol it names changed its signature or went away.
    const broken = !fact && [...(uses.get(file) ?? [])].some(([to, u]) =>
      (symbols.get(to) ?? []).some((s) => u.names.has(s.name) && (s.signatureChanged || s.change === 'removed')));
    const status: Status | undefined = fact ? (fact.status === 'added' ? 'added' : fact.status === 'deleted' ? 'removed' : 'changed') : broken ? 'affected' : undefined;
    const notes = [
      ...(fact?.oldPath && fact.status === 'renamed' ? [`moved from ${fact.oldPath}`] : []),
      ...(fact?.skipped ? [`not read: ${fact.skipped} · ${delta(fact)}`] : []),
      ...(fact && !fact.skipped && !list.length ? [`${delta(fact)} lines`] : []),
      ...(list.length > ROWS ? [`and ${count(list.length - ROWS, 'more symbol')}`] : []),
    ];
    const group = groups.get(file);
    elements.push({
      id: file, type: 'file', name: file,
      ...(status ? { status } : {}),
      ...(shown.length ? { symbols: shown } : {}),
      ...(notes.length ? { description: notes.join(' · ') } : {}),
      ...(grouped && group !== undefined ? { parent: groupId(group) } : {}),
      meta: { inDiff: Boolean(fact), test: tests.has(file) },
    });
  }

  const relationships: SpecRelationship[] = [];
  for (const from of drawn) {
    for (const [to, u] of uses.get(from) ?? []) {
      if (!drawn.includes(to)) continue;
      const row = rows.get(to)!;
      const live = [...new Set([...u.names, ...u.added])].sort();
      // In a new file every import is new, so the mark would say nothing: it is for an import a file gained.
      const gained = changed.get(from)?.status !== 'added';
      // One line for each name that has a row. A name the change added to the import carries the added mark.
      for (const toSymbol of live.filter((n) => row.has(n))) relationships.push({ from, to, label: '', toSymbol, ...(gained && u.added.has(toSymbol) ? { status: 'added' as const } : {}) });
      for (const toSymbol of [...u.removed].filter((n) => row.has(n) && !live.includes(n)).sort()) relationships.push({ from, to, label: '', toSymbol, status: 'removed' });
      // One line to the file when that is all the source proves: a whole-module import, or names with no row.
      const toFile = live.some((n) => !row.has(n)) || (!live.length && (u.whole || u.fresh));
      if (toFile) relationships.push({ from, to, label: '', ...(gained && (u.fresh || (!u.names.size && u.added.size > 0)) ? { status: 'added' as const } : {}) });
      else if (!live.length && !relationships.some((r) => r.from === from && r.to === to) && (u.gone || u.removed.size > 0)) relationships.push({ from, to, label: '', status: 'removed' });
    }
  }

  const leftOut = code.filter((f) => !drawn.includes(f.path));
  const changedLeftOut = leftOut.map((f) => f.path);
  const dependentsLeftOut = importers.filter((f) => !drawn.includes(f)).sort();
  const other = facts.files.filter((f) => !isCode(f)).length;
  const moved = facts.files.filter((f) => f.status === 'renamed').length;
  const biggest = leftOut.slice(0, 2).map((f) => `${base(f.path)} (${delta(changed.get(f.path)!)})`);
  const parts = [
    `${drawn.filter((f) => changed.has(f)).length} of ${count(code.length, 'changed source file')} drawn`,
    ...(leftOut.length ? [`Not drawn: ${biggest.join(', ')}${leftOut.length > 2 ? ` and ${leftOut.length - 2} more` : ''}`] : []),
    ...(dependentsLeftOut.length ? [`${count(dependentsLeftOut.length, 'more importer')} not drawn`] : []),
    ...(moved ? [`${count(moved, 'file')} moved`] : []),
    ...(other > 0 ? [`${count(other, 'other changed file')} (pages, config, assets)`] : []),
  ];
  return {
    spec: {
      title: opts.title ?? `Changed code: ${short(facts.base)}..${short(facts.head)}`,
      type: 'code',
      scope: `${short(facts.base)}..${short(facts.head)}. ${parts.join('. ')}`,
      direction: 'RIGHT',
      elements,
      relationships,
    },
    drawn: drawn.length, changedLeftOut, dependentsLeftOut,
    notRead: facts.files.filter((f) => f.skipped).map((f) => ({ path: f.path, reason: f.skipped! })),
  };
}
