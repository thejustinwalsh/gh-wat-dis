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
/** A file gets at most this many rows for names that another file newly imports from it. */
const IMPORT_ROWS = 2;
/** Slots kept for files outside the diff: the ones that import a changed symbol, and the ones a changed file newly imports. */
const CONTEXT_SLOTS = 2;
/** Rows of changed symbols a card lists. With the rows for newly imported names it stays within the 8 a card draws. */
const ROWS = 6;
/** One pair of files gets at most this many lines to rows. Past it, one line to the file stands for the rest. */
const LINES_PER_PAIR = 4;
const CHANGE: Record<string, Status> = { added: 'added', removed: 'removed', modified: 'changed' };
const short = (sha: string): string => (/^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 7) : sha.toLowerCase().replace('_', ' '));
const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const base = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const delta = (f: FileFact): string => [f.insertions ? `+${f.insertions}` : '', f.deletions ? `−${f.deletions}` : ''].filter(Boolean).join(' ') || '0 lines';
const FIXTURE = /(^|\/)(fixtures?|__fixtures__|__mocks__|golden|testdata|snapshots?)(\/|\.)|\.snap$/;
const CONFIG = /(^|\/)[^/]*\.config\.[cm]?[jt]s$/;
/** Pages and styles are not code the tools would read symbols from. */
const MARKUP = /\.(html?|css|scss|sass|less|svg|xml)$/;
const E2E = /(^|\/)(e2e|playwright|cypress)\/|\.(e2e|spec)\.[a-z]+$/;

/**
 * Facts as a code diagram. A card for each changed source file, largest change first, then for the
 * files outside the diff that the change touches: files that import a changed symbol, and files a
 * changed file starts to import. A row for each symbol the change added, changed or removed.
 *
 * One rule decides the lines, whichever side of the diff a file is on: every import the source
 * proves between two drawn files is a line. It ends on a symbol row when the import names a symbol
 * that has a row, and on the file when it names nothing that has one (the whole module, or names
 * that did not change). A line is marked added when the import is not on base, which is every
 * import of a new file, and removed when it is not on head. So no line between two cards means no import.
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
  // A list of re-exports, a fixture, a test or a build config holds little of a change, so it ranks low.
  const isCode = (f: FileFact): boolean => f.language !== null && (f.kind === 'source' || f.kind === 'test') && !f.binary;
  const barrel = (path: string): boolean => (symbols.get(path) ?? []).length > 0 && symbols.get(path)!.every((s) => s.kind === 'reexport');
  const weight = (f: FileFact): number => {
    const own = f.insertions + f.deletions + 3 * [...rise].filter(([k]) => k.startsWith(`${f.path}\0`)).reduce((n, [, v]) => n + v, 0);
    return own * (barrel(f.path) ? 0.15 : 1) * (FIXTURE.test(f.path) ? 0.25 : E2E.test(f.path) ? 0.3 : tests.has(f.path) || f.kind === 'test' ? 0.5 : 1) * (CONFIG.test(f.path) ? 0.25 : 1);
  };
  const code = facts.files.filter(isCode)
    // A file that only moved has nothing to show on a card. The scope line counts the moves.
    .filter((f) => symbols.has(f.path) || f.skipped !== undefined || f.insertions + f.deletions > 0)
    .sort((a, b) => weight(b) - weight(a) || a.path.localeCompare(b.path));

  // Every proven import, as from -> to -> what is imported. A file in the diff lists all its imports in the
  // facts. A file outside the diff is known through the changed symbols it names and the changed files it imports.
  type Use = { kept: Set<string>; added: Set<string>; removed: Set<string>; whole: boolean; fresh: boolean; gone: boolean; other: boolean };
  const uses = new Map<string, Map<string, Use>>();
  const use = (from: string, to: string): Use => {
    const targets = uses.get(from) ?? uses.set(from, new Map()).get(from)!;
    return targets.get(to) ?? targets.set(to, { kept: new Set(), added: new Set(), removed: new Set(), whole: false, fresh: false, gone: false, other: false }).get(to)!;
  };
  const listed = new Set(facts.imports.map((i) => i.from));
  for (const i of facts.imports) {
    if (i.from === i.to) continue;
    const u = use(i.from, i.to);
    for (const name of i.names) (i.change === 'added' ? u.added : i.change === 'removed' ? u.removed : u.kept).add(name);
    if (i.change === 'added' && (i.whole || !i.names.length)) { u.fresh = true; u.whole = true; }
    if (i.change === 'unchanged' && (i.whole || !i.names.length)) u.whole = true;
    if (i.change === 'removed' && (i.whole || !i.names.length)) u.gone = true;
  }
  for (const s of facts.symbols) {
    for (const d of s.dependents) {
      if (d.file === s.file || listed.has(d.file)) continue;
      if (d.provenance === 'resolved') use(d.file, s.file).kept.add(s.name); else use(d.file, s.file).whole = true;
    }
  }
  for (const d of facts.dependents.direct) {
    if (listed.has(d.file)) continue;
    for (const file of d.imports) {
      const u = use(d.file, file);
      const mine = d.symbols.filter((name) => symbols.get(file)?.some((s) => s.name === name));
      for (const name of mine) u.kept.add(name);
      // It imports the file and names none of its changed symbols: the whole module, or names that did not change.
      if (!mine.length) { if (d.provenance === 'heuristic') u.whole = true; else u.other = true; }
    }
  }
  const changedNames = (file: string): Set<string> => new Set((symbols.get(file) ?? []).map((s) => s.name));
  /** True when the import reaches something the change touched: a changed symbol by name, or the whole of a file that has one. */
  const touches = (to: string, u: Use): boolean => {
    const names = changedNames(to);
    return names.size > 0 && (u.whole || [...u.kept, ...u.added, ...u.removed].some((n) => names.has(n)));
  };

  // Slots: changed files first, with a few kept for the files around them.
  const reach = (file: string): number => [...(uses.get(file) ?? [])].filter(([to, u]) => changed.has(to) && touches(to, u))
    .reduce((n, [to, u]) => n + 1 + 2 * [...u.kept, ...u.added].filter((x) => changedNames(to).has(x)).length, 0);
  const importers = [...uses.keys()].filter((f) => !changed.has(f) && reach(f) > 0)
    .sort((a, b) => Number(tests.has(a)) - Number(tests.has(b)) || reach(b) - reach(a) || a.localeCompare(b));
  // A file outside the diff that a changed file starts to import by name.
  const newlyImported = new Map<string, number>();
  for (const i of facts.imports) if (i.change === 'added' && !i.toInDiff && i.names.length) newlyImported.set(i.to, (newlyImported.get(i.to) ?? 0) + i.names.length);
  const context = [...new Set([...importers, ...[...newlyImported.keys()].sort((a, b) => newlyImported.get(b)! - newlyImported.get(a)! || a.localeCompare(b))])];
  const kept = Math.min(context.length, CONTEXT_SLOTS, max - 1);
  const drawn: string[] = code.slice(0, Math.max(1, max - kept)).map((f) => f.path);
  // The file with the most change is the one a reader comes for. A file that imports it by name is kept before any other extra card.
  const top = drawn[0];
  const ofTop = top === undefined ? [] : [...uses].filter(([from, targets]) => !drawn.includes(from) && targets.has(top) && touches(top, targets.get(top)!)).map(([from]) => from)
    .sort((a, b) => Number(!changed.has(a)) - Number(!changed.has(b)) || reach(b) - reach(a) || a.localeCompare(b));
  const around = context.filter((f) => [...(uses.get(f) ?? [])].some(([to, u]) => drawn.includes(to) && touches(to, u)) || drawn.some((d) => uses.get(d)?.has(f)));
  for (const f of [...ofTop.slice(0, 1), ...around, ...code.map((c) => c.path)]) if (drawn.length < max && !drawn.includes(f)) drawn.push(f);

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
    // New exports first, then the most changed. A private constant of a script or a test says least, so it goes last.
    const rank = (s: SymbolFact): number => (s.kind === 'reexport' ? 3 : !s.exported && s.kind === 'const' ? 2 : s.exported && s.change === 'added' ? 0 : 1);
    const list = [...(symbols.get(file) ?? [])].sort((a, b) => rank(a) - rank(b) || amount(b) - amount(a) || a.name.localeCompare(b.name));
    const shown: SpecSymbol[] = list.slice(0, ROWS).map((s) => ({ name: s.name, kind: s.kind, status: CHANGE[s.change]! }));
    // A name that another drawn file starts to import from this one gets a row with no mark, so the line has a row to end on.
    const wanted = new Set<string>();
    for (const from of drawn) for (const name of uses.get(from)?.get(file)?.added ?? []) if (!list.some((s) => s.name === name)) wanted.add(name);
    const extra = [...wanted].sort().slice(0, IMPORT_ROWS);
    shown.push(...extra.map((name) => ({ name })));
    rows.set(file, new Set(shown.map((s) => s.name)));
    // A file outside the diff is affected when a symbol it names changed its signature or went away.
    const broken = !fact && [...(uses.get(file) ?? [])].some(([to, u]) =>
      (symbols.get(to) ?? []).some((s) => u.kept.has(s.name) && (s.signatureChanged || s.change === 'removed')));
    const status: Status | undefined = fact ? (fact.status === 'added' ? 'added' : fact.status === 'deleted' ? 'removed' : 'changed') : broken ? 'affected' : undefined;
    const mine = facts.imports.filter((i) => i.from === file && i.change !== 'unchanged');
    const notes = [
      ...(fact?.oldPath && fact.status === 'renamed' ? [`moved from ${fact.oldPath}`] : []),
      ...(fact?.skipped ? [`not read: ${fact.skipped} · ${delta(fact)}`] : []),
      ...(fact && !fact.skipped && !list.length ? [mine.length && mine.every((i) => i.testOnly) ? `${delta(fact)} lines, in test code only` : `${delta(fact)} lines`] : []),
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
      const live = [...new Set([...u.kept, ...u.added])].sort();
      const onRows = live.filter((n) => row.has(n)).slice(0, LINES_PER_PAIR);
      // One line for each name that has a row. A name the change added to the import carries the added mark.
      for (const toSymbol of onRows) relationships.push({ from, to, label: '', toSymbol, ...(u.added.has(toSymbol) ? { status: 'added' as const } : {}) });
      for (const toSymbol of [...u.removed].filter((n) => row.has(n) && !live.includes(n)).sort()) relationships.push({ from, to, label: '', toSymbol, status: 'removed' });
      // One line to the file for what has no row: the whole module, or names that are not rows.
      const rest = live.filter((n) => !onRows.includes(n));
      if (rest.length || u.whole || u.other) {
        const allNew = u.fresh || (rest.length > 0 && rest.every((n) => u.added.has(n)) && !u.whole && !u.other);
        relationships.push({ from, to, label: '', ...(allNew ? { status: 'added' as const } : {}) });
      } else if (!live.length && !relationships.some((r) => r.from === from && r.to === to) && (u.gone || u.removed.size > 0)) {
        relationships.push({ from, to, label: '', status: 'removed' });
      }
    }
  }

  const leftOut = code.filter((f) => !drawn.includes(f.path));
  const changedLeftOut = leftOut.map((f) => f.path);
  const dependentsLeftOut = importers.filter((f) => !drawn.includes(f)).sort();
  // Source the tools do not parse is still source: it is named as such, with its languages.
  const unparsed = facts.files.filter((f) => f.language === null && f.kind === 'source' && !MARKUP.test(f.path));
  const kinds = [...new Set(unparsed.map((f) => `.${f.path.slice(f.path.lastIndexOf('.') + 1)}`))].sort();
  const other = facts.files.filter((f) => !isCode(f) && !unparsed.includes(f)).length;
  const moved = facts.files.filter((f) => f.status === 'renamed').length;
  const biggest = leftOut.slice(0, 2).map((f) => `${base(f.path)} (${delta(changed.get(f.path)!)})`);
  const parts = [
    `${drawn.filter((f) => changed.has(f)).length} of ${count(code.length, 'changed source file')} drawn`,
    ...(leftOut.length ? [`Not drawn: ${biggest.join(', ')}${leftOut.length > 2 ? ` and ${leftOut.length - 2} more` : ''}`] : []),
    ...(dependentsLeftOut.length ? [`${count(dependentsLeftOut.length, 'more importer')} not drawn`] : []),
    ...(moved ? [`${count(moved, 'file')} moved`] : []),
    ...(unparsed.length ? [`${count(unparsed.length, 'changed source file')} in a language the tools do not read (${kinds.join(', ')})`] : []),
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
    notRead: [...facts.files.filter((f) => f.skipped).map((f) => ({ path: f.path, reason: f.skipped! })), ...unparsed.map((f) => ({ path: f.path, reason: 'a language the tools do not read' }))],
  };
}
