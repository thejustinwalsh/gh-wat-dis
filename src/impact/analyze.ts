import { resolve } from 'node:path';
import { extOf, kindOf, languageOf, schemaKind } from './classify.ts';
import { loadCodeowners, ownersOf } from './codeowners.ts';
import type { ElementMap } from './elements.ts';
import { buildElements } from './elements.ts';
import { diffEntries, history, readBlobs, resolveRange, tryGit, webUrl } from './git.ts';
import type { DiffEntry } from './git.ts';
import { complexityFacts } from './complexity.ts';
import type { Side } from './complexity.ts';
import { buildGraph, reverseReach } from './graph.ts';
import { diffManifest, isManifest } from './manifests.ts';
import type { Graph, InEdge } from './model.ts';
import { starTargets } from './model.ts';
import type { SymbolChange } from './symbols.ts';
import { diffSymbols } from './symbols.ts';
import { commitTree, repoTop, workingTree } from './tree.ts';
import type { Tree } from './tree.ts';
import type {
  AnalyzeOptions, ComplexityFact, CoChangeFact, ContractFact, DependencyFact, DirectDependent, EdgeFact, ElementFact, Facts, FileFact, FileKind,
  OwnerFact, Provenance, SymbolDependent, SymbolFact, TransitiveRollup,
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
  const needBase = entries.filter((e) => e.status !== 'added' && (languageOf(basePath(e)) || isManifest(basePath(e)))).map(basePath);
  const [baseBlobs, commits] = await Promise.all([
    readBlobs(root, range.base, needBase),
    history(root, range.head ?? 'HEAD', new Date(now.getTime() - 90 * DAY), now),
  ]);
  const touched = new Set(entries.flatMap((e) => [e.path, ...(e.oldPath ? [e.oldPath] : [])]));
  const hist = coChange(commits, touched, (p) => tree.has(p));

  // Symbols, and the element pairs the changed files contributed on each side.
  const symbols: SymbolFact[] = [];
  const baseRows: [string, string[]][] = [];
  const headRows: [string, string[]][] = [];
  const changedNames = new Map<string, Set<string>>();
  let baseGraphGaps = 0;
  for (const e of entries) {
    const head = graph.nodes.get(e.path);
    if (head) headRows.push([e.path, head.edges.filter((x) => !x.traced).map((x) => x.to)]);
    const baseText = e.status === 'added' ? undefined : baseBlobs.get(basePath(e));
    const baseLang = languageOf(basePath(e));
    const base = baseText !== undefined && baseLang ? graph.resolveOther(baseLang === 'rust' ? e.path : basePath(e), baseText) : null;
    if (base) baseRows.push([basePath(e), base.targets]);
    else if (e.status !== 'added' && baseLang) baseGraphGaps++;
    if ((e.status === 'added' ? !head : e.status === 'deleted' ? !base : !head || !base)) continue;
    const element = els.of(e.path);
    for (const c of diffSymbols(base?.syms ?? null, head?.syms ?? null)) {
      const { container: _container, ...fact } = c;
      void _container;
      symbols.push({
        ...fact, file: e.path, element,
        dependents: c.exported ? symbolDependents(graph, els, e.path, c, (f) => changed.has(f)) : [],
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
  const files: FileFact[] = entries.map((e) => ({
    path: e.path, status: e.status, ...(e.oldPath ? { oldPath: e.oldPath } : {}),
    insertions: e.insertions, deletions: e.deletions, ...(e.binary ? { binary: true } : {}),
    kind: graph.nodes.get(e.path)?.isTest ? 'test' : kindOf(e.path), language: languageOf(e.path), element: els.of(e.path),
    owners: ownersOf(co, e.path).owners, churn90d: hist.churn.get(e.path) ?? 0, hunkFunctions: e.hunkFunctions,
    provenance: 'exact', source: 'git',
  }));

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
      const added = dependencies.some((d) => d.manifest === p.manifest && d.name === dep && d.change === 'added');
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
  const elements: ElementFact[] = els.defs.map((d) => {
    const row = perElement.get(d.id) ?? { changed: 0, added: 0 };
    const dependentsAffected = dependentsByElement.get(d.id) ?? 0;
    const status = !row.changed ? (dependentsAffected ? 'affected' : 'unchanged')
      : d.files === 0 ? 'removed' : row.added === d.files ? 'added' : 'changed';
    const { found: _found, globs: _globs, ...rest } = d;
    void _found; void _globs;
    return { ...rest, status, filesChanged: row.changed, dependentsAffected };
  });

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
  if (baseGraphGaps) caveats.push(`${baseGraphGaps} changed file(s) had no readable base version; their base imports are not counted`);
  if (reach.size > entries.length) caveats.push(`transitive dependents are followed ${depth} import hops; a file that imports a re-exporting module counts even when it uses other names from it`);
  if (!co) caveats.push('no CODEOWNERS file; owners are empty');
  if (entries.some((e) => e.binary)) caveats.push('binary files have no line counts');

  let complexity: ComplexityFact[] = [];
  let measured = false;
  if (opts.cccc) {
    const sides: Side[] = files.filter((f) => f.kind === 'source' && f.language && !f.binary).map((f) => {
      const e = changed.get(f.path)!;
      const head = e.status === 'deleted' ? undefined : tree.read(f.path);
      const base = e.status === 'added' ? undefined : baseBlobs.get(basePath(e));
      return { path: f.path, basePath: basePath(e), ...(base !== undefined ? { base } : {}), ...(head !== undefined ? { head } : {}) };
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
  return {
    schema: 1,
    base: range.base,
    head: range.head ?? 'WORKING_TREE',
    range: { baseRef: range.baseRef, headRef: range.head ? range.headRef : 'working tree', workingTree: !range.head, depth },
    ...(repository ? { repository } : {}),
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
    elements,
    edges: [...edges.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    contracts,
    tests: { changed: files.filter((f) => f.kind === 'test').map((f) => f.path), importingChanged: directList.filter((d) => d.isTest).map((d) => d.file) },
    coChange: hist.pairs,
    dependencies,
    complexity,
    owners: [...owners.values()].sort((a, b) => b.files.length - a.files.length || a.owner.localeCompare(b.owner)),
    caveats,
  };
}
