import { resolve } from 'node:path';
import { CONFIG_REL } from '../cli/util.ts';
import { MAX_PARSE_BYTES, extOf, isSkipped, kindOf, languageOf, schemaKind } from './classify.ts';
import { loadCodeowners, ownersOf } from './codeowners.ts';
import type { ElementMap } from './elements.ts';
import { buildElements } from './elements.ts';
import { diffEntries, history, readBlobs, resolveRange, tryGit, webUrl } from './git.ts';
import type { DiffEntry } from './git.ts';
import { complexityFacts } from './complexity.ts';
import { decideDiagram } from './decide.ts';
import { diffParts, fileParts, isWorkflow, manifestParts, reordered, sourceParts, workflowParts } from './parts.ts';
import type { Declared } from './parts.ts';
import type { Side } from './complexity.ts';
import { buildGraph, reverseReach } from './graph.ts';
import { diffManifest, isManifest, packageName } from './manifests.ts';
import type { Graph, InEdge } from './model.ts';
import { starTargets } from './model.ts';
import type { SymbolChange } from './symbols.ts';
import { diffSymbols } from './symbols.ts';
import { commitTree, repoTop, workingTree } from './tree.ts';
import type { Tree } from './tree.ts';
import type {
  AnalyzeOptions, ComplexityFact, CoChangeFact, ContractFact, DependencyFact, DirectDependent, EdgeFact, ElementFact, Facts, FileFact, FileKind, ImportFact,
  OwnerFact, PartFact, Provenance, SymbolDependent, SymbolFact, TransitiveRollup,
} from './types.ts';

export const DEFAULT_DEPTH = 3;
const DAY = 86_400_000;
const CO_MIN_COMMITS = 3;
const CO_MIN_RATIO = 0.3;
const CO_MAX_COMMIT_FILES = 50;

async function untracked(tree: Tree, entries: DiffEntry[]): Promise<DiffEntry[]> {
  const out = await tryGit(tree.root, ['ls-files', '-z', '--others', '--exclude-standard']);
  const known = new Set(entries.map((e) => e.path));
  return (out ?? '').split('\0').filter((p) => p && !known.has(p)).map((path) => {
    const text = tree.size(path) <= 500 * 1024 ? tree.read(path) ?? '' : '';
    const binary = text.includes('\0');
    return { path, status: 'added', insertions: binary || !text ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0), deletions: 0, binary, hunkFunctions: [] };
  });
}

function coChange(commits: string[][], touched: Set<string>, exists: (p: string) => boolean): { churn: Map<string, number>; pairs: CoChangeFact[] } {
  const churn = new Map<string, number>();
  const together = new Map<string, Map<string, number>>();
  for (const files of commits) {
    for (const f of files) churn.set(f, (churn.get(f) ?? 0) + 1);
    if (files.length > CO_MAX_COMMIT_FILES) continue;
    for (const t of files) {
      if (!touched.has(t)) continue;
      const row = together.get(t) ?? new Map<string, number>();
      together.set(t, row);
      for (const o of files) if (!touched.has(o)) row.set(o, (row.get(o) ?? 0) + 1);
    }
  }
  const pairs: CoChangeFact[] = [];
  for (const [withFile, row] of together) {
    for (const [file, commitsTogether] of row) {
      const ratio = commitsTogether / churn.get(withFile)!;
      if (commitsTogether >= CO_MIN_COMMITS && ratio >= CO_MIN_RATIO && exists(file)) {
        pairs.push({ file, withFile, commits: commitsTogether, ratio: Math.round(ratio * 100) / 100, provenance: 'measured' });
      }
    }
  }
  pairs.sort((a, b) => b.commits - a.commits || b.ratio - a.ratio || a.file.localeCompare(b.file));
  return { churn, pairs };
}

function symbolDependents(graph: Graph, els: ElementMap, file: string, c: SymbolChange, inDiff: (f: string) => boolean): SymbolDependent[] {
  const found = new Map<string, Provenance>();
  const note = (from: string, p: Provenance): void => { if (from !== file && found.get(from) !== 'resolved') found.set(from, p); };
  const scan = (edges: InEdge[] | undefined, name: string, exact: Provenance): void => {
    for (const { from, edge } of edges ?? []) {
      if (edge.names.includes(name)) note(from, exact);
      else if (edge.whole && c.change !== 'added') note(from, 'heuristic');
    }
  };
  if (c.container) scan(graph.rev.get(file), c.container, 'heuristic');
  else scan(graph.rev.get(file), c.name, 'resolved');
  if (c.change === 'removed' && !c.container) {
    for (const node of graph.nodes.values()) {
      for (const edge of node.edges) {
        if (edge.unresolved?.includes(c.name) && starTargets(graph.nodes, edge.to).has(file)) note(node.path, 'resolved');
      }
    }
  }
  return [...found].map(([f, provenance]) => ({ file: f, element: els.of(f), inDiff: inDiff(f), provenance })).sort((a, b) => a.file.localeCompare(b.file));
}

/** The elements and relationships of an architecture map, each as text that changes when its entry does. */
function mapOf(text: string | null): { elements: Map<string, string>; relationships: Set<string> } | null {
  // No map on that side: the map is new, and a new map describes the architecture, it does not add to it.
  if (text === null) return null;
  try {
    const arch = (JSON.parse(text) as { architecture?: { elements?: { id?: string }[]; relationships?: { from?: string; to?: string }[] } }).architecture;
    return {
      elements: new Map((arch?.elements ?? []).filter((e) => e?.id).map((e) => [e.id!, JSON.stringify(e)])),
      relationships: new Set((arch?.relationships ?? []).map((r) => `${r.from}\0${r.to}`)),
    };
  } catch { return null; }
}

function pairCounts(els: ElementMap, rows: Iterable<[string, string[]]>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [from, targets] of rows) {
    const a = els.of(from);
    for (const to of new Set(targets)) {
      const b = els.of(to);
      if (a !== b) out.set(`${a}\0${b}`, (out.get(`${a}\0${b}`) ?? 0) + 1);
    }
  }
  return out;
}

export async function analyze(opts: AnalyzeOptions = {}): Promise<Facts> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  if ((await tryGit(cwd, ['rev-parse', '--git-dir'])) === null) throw new Error(`not a git repository: ${cwd}`);
  const root = await repoTop(cwd);
  const depth = opts.depth ?? DEFAULT_DEPTH;
  const now = opts.now ?? new Date();
  const range = await resolveRange(root, opts);
  const caveats = [...range.caveats];

  const tree = range.head ? await commitTree(root, range.head) : await workingTree(root);
  const entries = await diffEntries(root, range.base, range.head);
  if (!range.head) entries.push(...await untracked(tree, entries));
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const changed = new Map(entries.map((e) => [e.path, e]));

  const graph = buildGraph(tree, (p) => changed.has(p));
  const els = buildElements(root, tree.files, graph.packages);
  const co = loadCodeowners((p) => tree.read(p));

  const basePath = (e: DiffEntry): string => e.oldPath ?? e.path;
  const needBase = entries.filter((e) => e.status !== 'added' && (languageOf(basePath(e)) || isManifest(basePath(e)) || isWorkflow(basePath(e)))).map(basePath);
  const [baseBlobs, commits] = await Promise.all([
    readBlobs(root, range.base, needBase),
    history(root, range.head ?? 'HEAD', new Date(now.getTime() - 90 * DAY), now),
  ]);
  // A package whose manifest moved or whose name changed is the same package renamed: its new name, then its old one.
  const renamedPkg = new Map<string, { from: string; manifest: string; named: boolean }>();
  for (const e of entries) {
    if (!isManifest(e.path) || e.status === 'added' || e.status === 'deleted') continue;
    const was = packageName(basePath(e), baseBlobs.get(basePath(e))), is = packageName(e.path, tree.read(e.path));
    if (was && is && (was !== is || basePath(e) !== e.path)) renamedPkg.set(is, { from: was === is ? basePath(e).replace(/\/[^/]*$/, '') : was, manifest: e.path, named: was !== is });
  }
  // A file that imported a renamed package by its old name imports the same package: it is read with the new name.
  const renamedText = (text: string): string => {
    for (const [is, r] of renamedPkg) if (r.named) text = text.replace(new RegExp(`(['"])${r.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=['"/])`, 'g'), `$1${is}`);
    return text;
  };
  const touched = new Set(entries.flatMap((e) => [e.path, ...(e.oldPath ? [e.oldPath] : [])]));
  const hist = coChange(commits, touched, (p) => tree.has(p));

  // Symbols, and the element pairs the changed files contributed on each side.
  // Paths that exist on base only, and where the moved ones went.
  const baseOnly = new Set(entries.flatMap((e) => (e.status === 'deleted' ? [e.path] : e.oldPath && e.oldPath !== e.path ? [e.oldPath] : [])));
  const movedTo = new Map(entries.filter((e) => e.oldPath && e.oldPath !== e.path).map((e) => [e.oldPath!, e.path]));
  const rustTreeMoved = entries.some((e) => languageOf(e.path) === 'rust' && e.status !== 'modified');
  let rustBlind = 0;
  const symbols: SymbolFact[] = [];
  const imports: ImportFact[] = [];
  const baseRows: [string, string[]][] = [];
  const headRows: [string, string[]][] = [];
  const changedNames = new Map<string, Set<string>>();
  let baseGraphGaps = 0;
  for (const e of entries) {
    const head = graph.nodes.get(e.path);
    if (head) headRows.push([e.path, head.edges.filter((x) => !x.traced).map((x) => x.to)]);
    const baseBlob = e.status === 'added' ? undefined : baseBlobs.get(basePath(e));
    const baseText = baseBlob === undefined ? undefined : renamedText(baseBlob);
    const baseLang = languageOf(basePath(e));
    const base = baseText !== undefined && baseLang ? graph.resolveOther(baseLang === 'rust' ? e.path : basePath(e), baseText, baseLang === 'rust' ? undefined : baseOnly) : null;
    // The base side is counted at the files' head paths, so that a package that moved is the same element on both sides.
    if (base) baseRows.push([e.path, base.targets.map((t) => movedTo.get(t) ?? t)]);
    else if (e.status !== 'added' && baseLang) baseGraphGaps++;
    if ((e.status === 'added' ? !head : e.status === 'deleted' ? !base : !head || !base)) continue;
    // The imports of this file: gained, lost and kept. Both sides are resolved the same way, without the
    // names that tracing through re-exports adds, so that a name counts as new only when the file gained it.
    // A file that moved is compared at its old path, and a target that moved is the same target.
    if (head) {
      const headText = tree.read(e.path);
      const fresh = headText === undefined ? null : graph.resolveOther(e.path, headText);
      const was = new Map((base?.edges ?? []).map((x) => [movedTo.get(x.to) ?? x.to, x]));
      const is = new Map((fresh?.edges ?? head.edges.filter((x) => !x.traced)).map((x) => [x.to, x]));
      // Rust resolves `use` paths through the module tree. When the change moves, adds or removes a module, the base
      // side cannot be resolved against it, so nothing is claimed as gained or lost: every import is listed as kept.
      const blind = head.language === 'rust' && rustTreeMoved && e.status !== 'added';
      if (blind) rustBlind++;
      for (const to of new Set([...was.keys(), ...is.keys()])) {
        const a = blind ? is.get(to) : was.get(to), b = is.get(to);
        const fact = (change: ImportFact['change'], names: string[], whole: boolean, testOnly: boolean): void => {
          imports.push({ from: e.path, to, toElement: els.of(to), toInDiff: changed.has(to), names: names.sort(), whole, ...(testOnly ? { testOnly } : {}), change, provenance: 'resolved' });
        };
        if (b) {
          const gained = b.names.filter((n) => !a?.names.includes(n)), kept = b.names.filter((n) => a?.names.includes(n));
          if (!a) fact('added', gained, b.whole, b.testOnly);
          else {
            if (gained.length || (b.whole && !a.whole)) fact('added', gained, b.whole && !a.whole, b.testOnly);
            if (kept.length || (b.whole && a.whole) || (!b.names.length && !b.whole)) fact('unchanged', kept, b.whole && a.whole, b.testOnly);
          }
        }
        if (a && !blind) {
          const lost = a.names.filter((n) => !b?.names.includes(n));
          if (!b) fact('removed', lost, a.whole, a.testOnly);
          else if (lost.length || (a.whole && !b.whole)) fact('removed', lost, a.whole && !b.whole, a.testOnly);
        }
      }
    }
    const element = els.of(e.path);
    for (const c of diffSymbols(base?.syms ?? null, head?.syms ?? null)) {
      const { container: _container, ...fact } = c;
      void _container;
      const was = c.change === 'modified' && /function|method/.test(c.kind) ? base?.syms.find((x) => x.name === (c.renamedFrom ?? c.name)) : undefined;
      const is = was ? head?.syms.find((x) => x.name === c.name) : undefined;
      symbols.push({
        ...fact, file: e.path, element,
        dependents: c.exported ? symbolDependents(graph, els, e.path, c, (f) => changed.has(f)) : [],
        ...(was && is && reordered(c.name, was.text, is.text) ? { callsReordered: true as const } : {}),
        provenance: 'resolved', source: 'ast-grep',
      });
      if (c.exported) (changedNames.get(e.path) ?? changedNames.set(e.path, new Set()).get(e.path)!).add(c.name);
    }
  }
  symbols.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));

  // Dependents.
  const direct = new Map<string, DirectDependent>();
  for (const e of entries) {
    const names = changedNames.get(e.path) ?? new Set<string>();
    for (const { from, edge } of graph.rev.get(e.path) ?? []) {
      if (changed.has(from)) continue;
      const named = edge.names.length > 0 || !edge.whole;
      const p: Provenance = named ? 'resolved' : 'heuristic';
      const node = graph.nodes.get(from)!;
      const d = direct.get(from) ?? { file: from, element: els.of(from), imports: [], via: [], symbols: [], isTest: node.isTest, provenance: p };
      direct.set(from, d);
      if (!d.imports.includes(e.path)) d.imports.push(e.path);
      for (const v of edge.via) if (!d.via.includes(v)) d.via.push(v);
      for (const n of edge.names) if (names.has(n) && !d.symbols.includes(n)) d.symbols.push(n);
      if (p === 'resolved') d.provenance = 'resolved';
      if (edge.testOnly && node.edges.filter((x) => changed.has(x.to)).every((x) => x.testOnly)) d.isTest = true;
    }
  }
  const directList = [...direct.values()].sort((a, b) => a.file.localeCompare(b.file));

  // The imports among the files a code diagram may draw: the changed files, the files that import them, and the
  // files they import. Then every import between two drawn cards is a line, whichever side of the diff each is on.
  // A file outside the diff reads the same on both sides, so its imports are kept ones. A name that reaches a file
  // through a module that re-exports it is listed with that module, and a re-export is an import of what it re-exports.
  // An import of a file that is new, or from one, was not there before: it is added.
  const near = new Set<string>([...changed.keys()].filter((p) => graph.nodes.has(p)));
  for (const d of directList) near.add(d.file);
  for (const i of imports) if (graph.nodes.has(i.to)) near.add(i.to);
  const listedPairs = new Set(imports.map((i) => `${i.from}\0${i.to}`));
  const kept = (from: string, to: string, names: string[], whole: boolean, testOnly: boolean, through?: string): void => {
    if (listedPairs.has(`${from}\0${to}`) || from === to) return;
    listedPairs.add(`${from}\0${to}`);
    imports.push({ from, to, toElement: els.of(to), toInDiff: changed.has(to), names: [...new Set(names)].sort(), whole, ...(testOnly ? { testOnly } : {}), change: changed.get(to)?.status === 'added' || changed.get(from)?.status === 'added' ? 'added' : 'unchanged', ...(through ? { through } : {}), provenance: 'resolved' });
  };
  for (const from of near) {
    const node = graph.nodes.get(from)!;
    const bySpec = new Map(node.edges.filter((x) => !x.traced).map((x) => [x.via[0], x.to]));
    for (const x of node.edges) {
      if (!near.has(x.to)) continue;
      // A changed file lists its direct imports with their changes above. Only what it reaches through a re-export is added here.
      if (changed.has(from) && !x.traced) continue;
      const through = x.traced ? bySpec.get(x.via[0]) : undefined;
      kept(from, x.to, x.names, x.whole, x.testOnly, through !== x.to ? through : undefined);
    }
    for (const sym of node.syms) {
      const to = sym.reexport?.to;
      // A Rust file that re-exports its own module has no import of it: that is structure, and the graph has no edge.
      if (from.endsWith('.rs') && to && !node.edges.some((x) => x.to === to)) continue;
      if (to && near.has(to)) kept(from, to, sym.name === '*' ? [] : [sym.reexport!.name], sym.name === '*', false);
    }
  }
  const reach = reverseReach(graph, entries.map((e) => e.path), depth);
  const rollup = new Map<string, TransitiveRollup>();
  const dependentsByElement = new Map<string, number>();
  for (const [file, d] of reach) {
    if (d === 0) continue;
    const element = els.of(file);
    const r = rollup.get(element) ?? { element, count: 0, minDepth: d, provenance: 'measured' as const };
    r.count++;
    r.minDepth = Math.min(r.minDepth, d);
    rollup.set(element, r);
    dependentsByElement.set(element, r.count);
  }
  const transitive = [...rollup.values()].sort((a, b) => a.minDepth - b.minDepth || b.count - a.count || a.element.localeCompare(b.element));

  // Files.
  const skippedFor = (path: string): string | undefined => {
    const lang = languageOf(path);
    if (!lang || isSkipped(path) || graph.nodes.has(path) || !tree.has(path)) return undefined;
    return tree.size(path) > MAX_PARSE_BYTES ? `larger than ${MAX_PARSE_BYTES / 1024} KB` : undefined;
  };
  const files: FileFact[] = entries.map((e) => ({
    path: e.path, status: e.status, ...(e.oldPath ? { oldPath: e.oldPath } : {}),
    insertions: e.insertions, deletions: e.deletions, ...(e.binary ? { binary: true } : {}),
    kind: graph.nodes.get(e.path)?.isTest ? 'test' : kindOf(e.path), language: languageOf(e.path), element: els.of(e.path),
    owners: ownersOf(co, e.path).owners, churn90d: hist.churn.get(e.path) ?? 0, // git names the enclosing function from the hunk header. Outside the languages it knows, that line is a CSS rule or a paragraph.
    hunkFunctions: languageOf(e.path) ? e.hunkFunctions : [],
    ...(skippedFor(e.path) ? { skipped: skippedFor(e.path)! } : {}),
    provenance: 'exact', source: 'git',
  }));
  const skipped = files.filter((f) => f.skipped);
  if (skipped.length) {
    const names = `${skipped.slice(0, 3).map((f) => f.path).join(', ')}${skipped.length > 3 ? `, and ${skipped.length - 3} more` : ''}`;
    graph.unavailable.push({ tool: 'ast-grep', reason: `${skipped.length} changed source file(s) larger than ${MAX_PARSE_BYTES / 1024} KB were not parsed: ${names}` });
    caveats.push(`${skipped.length} changed source file(s) larger than ${MAX_PARSE_BYTES / 1024} KB were not parsed, so their symbols, imports and complexity are missing: ${names}`);
  }

  const owners = new Map<string, OwnerFact>();
  const ownerRow = (o: string): OwnerFact => owners.get(o) ?? owners.set(o, { owner: o, files: [], dependentFiles: [] }).get(o)!;
  for (const f of files) for (const o of f.owners) ownerRow(o).files.push(f.path);
  for (const d of directList) for (const o of ownersOf(co, d.file).owners) ownerRow(o).dependentFiles.push(d.file);

  // Edges.
  const headAll = pairCounts(els, [...graph.nodes.values()].map((n) => [n.path, n.edges.filter((x) => !x.traced).map((x) => x.to)]));
  const headPart = pairCounts(els, headRows);
  const basePart = pairCounts(els, baseRows);
  const edges = new Map<string, EdgeFact>();
  for (const key of new Set([...headAll.keys(), ...basePart.keys()])) {
    const [from, to] = key.split('\0') as [string, string];
    const weight = headAll.get(key) ?? 0;
    const before = weight - (headPart.get(key) ?? 0) + (basePart.get(key) ?? 0);
    if (!weight && before <= 0) continue;
    edges.set(key, { from, to, weight, status: !weight ? 'removed' : before <= 0 ? 'added' : 'unchanged', provenance: 'resolved', source: 'ast-grep' });
  }
  const dependencies: DependencyFact[] = [];
  for (const e of entries) {
    if (isManifest(e.path) || isManifest(basePath(e))) dependencies.push(...diffManifest(e.path, e.status === 'added' ? undefined : baseBlobs.get(basePath(e)), e.status === 'deleted' ? undefined : tree.read(e.path)));
  }
  const pkgByName = new Map(graph.packages.map((p) => [p.name, p]));
  const declare = (from: string, to: string, status: EdgeFact['status']): void => {
    if (from === to) return;
    const cur = edges.get(`${from}\0${to}`);
    if (cur) Object.assign(cur, { provenance: 'exact', source: 'manifest', ...(status !== 'unchanged' && cur.weight === 0 ? { status } : {}) });
    else edges.set(`${from}\0${to}`, { from, to, weight: 0, status, provenance: 'exact', source: 'manifest' });
  };
  for (const p of graph.packages) {
    for (const dep of p.deps) {
      // A dependency on a package that was renamed is the same dependency when the old name went from this manifest.
      const renamedFrom = renamedPkg.get(dep)?.from;
      const added = dependencies.some((d) => d.manifest === p.manifest && d.name === dep && d.change === 'added')
        && !dependencies.some((d) => d.manifest === p.manifest && d.name === renamedFrom && d.change === 'removed');
      declare(els.of(p.manifest), els.of(pkgByName.get(dep)!.manifest), added && !dependencies.some((d) => d.manifest === p.manifest && d.name === dep && d.change === 'removed') ? 'added' : 'unchanged');
    }
  }
  for (const d of dependencies) {
    const target = pkgByName.get(d.name);
    const owner = graph.packages.find((p) => p.manifest === d.manifest);
    if (d.change === 'removed' && target && owner && !owner.deps.includes(d.name)) declare(els.of(owner.manifest), els.of(target.manifest), 'removed');
  }
  const ids = new Set(els.defs.map((d) => d.id));
  for (const r of els.relationships) {
    if (!ids.has(r.from) || !ids.has(r.to) || !r.label || r.from === r.to) continue;
    const key = `${r.from}\0${r.to}`;
    const cur = edges.get(key) ?? { from: r.from, to: r.to, weight: 0, status: 'unchanged' as const, provenance: 'exact' as const, source: 'config' as const };
    edges.set(key, { ...cur, label: r.label, ...(r.technology ? { technology: r.technology } : {}), provenance: 'exact', source: 'config' });
  }

  // Elements.
  const perElement = new Map<string, { changed: number; added: number }>();
  const bump = (element: string, added: boolean): void => {
    const row = perElement.get(element) ?? { changed: 0, added: 0 };
    row.changed++;
    if (added) row.added++;
    perElement.set(element, row);
  };
  for (const f of files) {
    bump(f.element, f.status === 'added' || f.status === 'renamed' && els.of(f.oldPath!) !== f.element);
    if (f.oldPath && f.status === 'renamed' && els.of(f.oldPath) !== f.element) bump(els.of(f.oldPath), false);
  }
  // A change to the architecture map is a change to the architecture: an element or a relationship
  // the map did not have on base is added, and an element whose entry differs is changed.
  const mapWas = els.mapping === 'config' && changed.has(CONFIG_REL) ? mapOf(await tryGit(root, ['show', `${range.base}:${CONFIG_REL}`])) : null;
  const mapIs = mapWas ? mapOf(range.head ? await tryGit(root, ['show', `${range.head}:${CONFIG_REL}`]) : tree.read(CONFIG_REL) ?? null) : null;
  const mapStatus = (id: string): 'added' | 'changed' | undefined => {
    if (!mapWas || !mapIs || !mapIs.elements.has(id)) return undefined;
    return !mapWas.elements.has(id) ? 'added' : mapWas.elements.get(id) !== mapIs.elements.get(id) ? 'changed' : undefined;
  };
  if (mapWas && mapIs) {
    for (const key of new Set([...mapWas.relationships, ...mapIs.relationships])) {
      const edge = edges.get(key);
      if (edge && edge.status === 'unchanged' && mapWas.relationships.has(key) !== mapIs.relationships.has(key)) edge.status = mapIs.relationships.has(key) ? 'added' : 'removed';
    }
  }
  const elements: ElementFact[] = els.defs.map((d) => {
    const row = perElement.get(d.id) ?? { changed: 0, added: 0 };
    const dependentsAffected = dependentsByElement.get(d.id) ?? 0;
    const status = mapStatus(d.id) === 'added' ? 'added' : !row.changed ? (mapStatus(d.id) ?? (dependentsAffected ? 'affected' : 'unchanged'))
      : d.files === 0 ? 'removed' : row.added === d.files ? 'added' : 'changed';
    const { found: _found, globs: _globs, ...rest } = d;
    void _found; void _globs;
    // A package that was renamed is changed, not added: its files moved in from its old name.
    const renamed = [...renamedPkg.values()].find((r) => els.of(r.manifest) === d.id);
    if (renamed) return { ...rest, status: status === 'added' || status === 'unchanged' ? 'changed' : status, renamedFrom: renamed.from, filesChanged: row.changed, dependentsAffected };
    return { ...rest, status, filesChanged: row.changed, dependentsAffected };
  });

  // Parts: what a user or another program calls by name, added or removed.
  const parts = partFacts(entries, (e) => (e.status === 'added' ? undefined : baseBlobs.get(basePath(e))), (p) => tree.read(p), (p) => tree.has(p) || baseOnly.has(p), els);

  // Contracts.
  const contracts: ContractFact[] = [];
  const entryOwners = new Map<string, string>();
  for (const p of graph.packages) {
    for (const node of graph.nodes.values()) {
      if (!node.path.startsWith(p.dir ? `${p.dir}/` : '')) continue;
      if (/(^|\/)src\/(lib\.rs|index\.[cm]?[jt]sx?)$/.test(node.path.slice(p.dir ? p.dir.length + 1 : 0)) || /^index\.[cm]?[jt]sx?$/.test(node.path.slice(p.dir ? p.dir.length + 1 : 0))) entryOwners.set(node.path, p.name);
    }
  }
  for (const f of files) {
    const delta = `+${f.insertions} −${f.deletions}`;
    if (f.kind === 'schema') contracts.push({ path: f.path, kind: schemaKind(f.path), note: `${f.status}, ${delta}`, provenance: 'heuristic' });
    else if (f.kind === 'migration') contracts.push({ path: f.path, kind: 'migration', note: `${f.status}, ${delta}`, provenance: 'heuristic' });
    else if (entryOwners.has(f.path)) {
      const mine = symbols.filter((s) => s.file === f.path && s.exported);
      const n = (k: string): number => mine.filter((s) => s.change === k).length;
      contracts.push({ path: f.path, kind: 'package-entry', note: `entry file of ${entryOwners.get(f.path)}: ${n('added')} exports added, ${n('removed')} removed, ${n('modified')} modified`, provenance: 'heuristic' });
    }
  }

  // Caveats.
  const noAst = new Set<string>();
  for (const f of files) if (f.kind === 'source' && !f.language) noAst.add(extOf(f.path));
  for (const ext of [...noAst].sort()) caveats.push(`no symbol analysis for .${ext}`);
  if (graph.nodes.size) {
    caveats.push('dependents are files whose imports resolve to a changed file; calls through dependency injection, reflection, string paths or generated code are not seen');
    caveats.push('edge status (added/removed) compares only the imports of files in this diff against base, resolved against the head file list');
  }
  if (rustBlind) caveats.push(`the change moves, adds or removes a Rust module, so the base imports of ${rustBlind} Rust file(s) cannot be resolved; their imports are listed as kept, and none as gained or lost`);
  if (baseGraphGaps) caveats.push(`${baseGraphGaps} changed file(s) had no readable base version; their base imports are not counted`);
  if (reach.size > entries.length) caveats.push(`transitive dependents are followed ${depth} import hops; a file that imports a re-exporting module counts even when it uses other names from it`);
  if (!co) caveats.push('no CODEOWNERS file; owners are empty');
  if (entries.some((e) => e.binary)) caveats.push('binary files have no line counts');

  let complexity: ComplexityFact[] = [];
  let measured = false;
  if (opts.cccc) {
    // A file that was not read on head has no head side: scoring it would count every function as removed.
    const sides: Side[] = files.filter((f) => f.kind === 'source' && f.language && !f.binary && !f.skipped).map((f) => {
      const e = changed.get(f.path)!;
      const head = e.status === 'deleted' ? undefined : tree.read(f.path);
      const base = e.status === 'added' ? undefined : baseBlobs.get(basePath(e));
      const renamed = new Map(symbols.filter((x) => x.file === f.path && x.renamedFrom).map((x) => [x.name, x.renamedFrom!]));
      return { path: f.path, basePath: basePath(e), ...(base !== undefined ? { base } : {}), ...(head !== undefined ? { head } : {}), ...(renamed.size ? { renamed } : {}) };
    });
    try { complexity = complexityFacts(opts.cccc, sides); measured = true; } catch (e) {
      graph.unavailable.push({ tool: 'cccc', reason: e instanceof Error ? e.message : String(e) });
    }
  } else if (opts.cccc === null) {
    graph.unavailable.push({ tool: 'cccc', reason: 'not installed. Run: npx gh-wat-dis doctor --tools install' });
  }
  const sum = (pick: (f: ComplexityFact) => number): number => complexity.reduce((n, f) => n + pick(f), 0);

  const byKind: Partial<Record<FileKind, number>> = {};
  for (const f of files) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
  const ran = ['git', ...(graph.nodes.size ? ['ast-grep'] : []), ...(co ? ['codeowners'] : []),
    ...(graph.packages.length || dependencies.length ? ['manifest'] : []), ...(els.mapping === 'config' ? ['config'] : []), ...(measured ? ['cccc'] : [])];

  const repository = webUrl(await tryGit(root, ['remote', 'get-url', 'origin']));
  const facts: Facts = {
    schema: 1,
    base: range.base,
    head: range.head ?? 'WORKING_TREE',
    range: { baseRef: range.baseRef, headRef: range.head ? range.headRef : 'working tree', workingTree: !range.head, depth },
    ...(repository ? { repository } : {}),
    diagram: { draw: false, level: null, reasons: [], skip: null, provenance: 'exact' },
    tiers: { ran, languages: graph.languages, unavailable: graph.unavailable },
    summary: {
      filesChanged: files.length,
      insertions: files.reduce((n, f) => n + f.insertions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
      byKind,
      elementsChanged: elements.filter((e) => e.filesChanged > 0).length,
      directDependents: directList.length,
      exportedSignatureChanges: symbols.filter((s) => s.exported && s.signatureChanged).length,
      ...(measured ? { complexity: {
        functions: complexity.length,
        cognitiveBefore: sum((f) => f.before?.cognitive ?? 0),
        cognitiveAfter: sum((f) => f.after?.cognitive ?? 0),
        largestRise: Math.max(0, ...complexity.map((f) => (f.after?.cognitive ?? 0) - (f.before?.cognitive ?? 0))),
        highestAfter: Math.max(0, ...complexity.map((f) => f.after?.cognitive ?? 0)),
      } } : {}),
    },
    files,
    symbols,
    dependents: { direct: directList, transitive },
    imports: imports.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.change.localeCompare(b.change)),
    elements,
    edges: [...edges.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    contracts,
    tests: { changed: files.filter((f) => f.kind === 'test').map((f) => f.path), importingChanged: directList.filter((d) => d.isTest).map((d) => d.file) },
    coChange: hist.pairs,
    dependencies,
    parts,
    complexity,
    owners: [...owners.values()].sort((a, b) => b.files.length - a.files.length || a.owner.localeCompare(b.owner)),
    caveats,
  };
  facts.diagram = decideDiagram(facts);
  return facts;
}

const VERB: Record<PartFact['kind'], string> = { command: 'Runs', tool: 'Runs', bin: 'Runs', option: 'Runs', skill: 'Loads', route: 'Calls', export: 'Imports', job: 'Schedules' };

/**
 * The parts each changed file declares on base and on head, compared. A part that leaves one file and appears in
 * another moved: it is neither added nor removed. A registry entry whose handler loads a module of this repository is
 * held by that module's element, which the import proves.
 */
function partFacts(entries: DiffEntry[], baseText: (e: DiffEntry) => string | undefined, headText: (p: string) => string | undefined,
  exists: (p: string) => boolean, els: ElementMap): PartFact[] {
  const out: { d: Declared; change: 'added' | 'removed'; file: string }[] = [];
  for (const e of entries) {
    const old = e.oldPath ?? e.path;
    const read = (path: string, text: string | undefined): Declared[] =>
      isManifest(path) ? manifestParts(path, text) : isWorkflow(path) ? workflowParts(path, text) : sourceParts(path, text);
    const a = e.status === 'added' ? [] : read(old, baseText(e));
    const b = e.status === 'deleted' ? [] : read(e.path, headText(e.path));
    // A file that is a part by itself counts when it comes or goes. Moved, it is the same part.
    if (e.status === 'added') b.push(...fileParts(e.path));
    if (e.status === 'deleted') a.push(...fileParts(e.path));
    const { added, removed } = diffParts(a, b);
    for (const d of added) out.push({ d, change: 'added', file: e.path });
    for (const d of removed) out.push({ d, change: 'removed', file: e.path });
  }
  const key = (x: { d: Declared }): string => `${x.d.kind}\0${x.d.name}`;
  const both = new Set(out.filter((x) => x.change === 'added').map(key).filter((k) => out.some((y) => y.change === 'removed' && key(y) === k)));
  const parentOf = new Map(els.defs.map((d) => [d.id, d.parent]));
  const lineage = (id: string): string[] => { const seen: string[] = []; for (let p: string | undefined = id; p && !seen.includes(p); p = parentOf.get(p)) seen.push(p); return seen; };
  const facts: PartFact[] = [];
  for (const { d, change, file } of out) {
    if (both.has(key({ d }))) continue;
    // Where the handler lives: the module a registry entry loads, or the file a bin entry runs.
    let impl: string | undefined;
    if (d.target) {
      const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
      const at = d.target.startsWith('.') ? normalize(`${dir}${d.target}`) : d.kind === 'bin' ? normalize(`${dir}${d.target}`) : '';
      const tries = at ? [at, at.replace(/\.js$/, '.ts'), at.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts'), `${at}.ts`, `${at}/index.ts`] : [];
      impl = tries.find((p) => exists(p));
    }
    const element = els.of(impl ?? file);
    const registry = els.of(file);
    const mine = lineage(element);
    let calledBy: PartFact['calledBy'];
    if (impl && d.source === 'ast-grep' && !mine.includes(registry)) calledBy = { element: registry, label: VERB[d.kind], provenance: 'resolved', source: 'ast-grep' };
    else {
      const r = els.relationships.find((x) => x.from && x.to && mine.includes(x.to) && !mine.includes(x.from) && parentOf.has(x.from));
      if (r) calledBy = { element: r.from, label: VERB[d.kind], ...(r.technology ? { technology: r.technology } : {}), provenance: 'exact', source: 'config' };
    }
    facts.push({
      name: d.name, kind: d.kind, change, element, file, line: d.line, basis: impl && d.source === 'ast-grep' ? `${d.basis}, handler in ${impl}` : d.basis,
      ...(calledBy ? { calledBy } : {}),
      provenance: impl && d.provenance === 'heuristic' && d.source === 'ast-grep' ? 'resolved' : d.provenance, source: d.source,
    });
  }
  return facts.sort((a, b) => a.element.localeCompare(b.element) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

/** A path with `.` and `..` segments folded. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const s of path.split('/')) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); }
  return out.join('/');
}
