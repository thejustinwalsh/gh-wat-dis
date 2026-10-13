import { MAX_PARSE_BYTES, isSkipped, isTestPath, languageOf } from './classify.ts';
import type { Edge, FileNode, Graph, InEdge, RawImport, Sym } from './model.ts';
import { mergeEdge, originOf, starTargets } from './model.ts';
import { parseRust, rustUnavailable } from './rust-parse.ts';
import type { ParsedRust } from './rust-parse.ts';
import { RustWorkspace } from './rust-resolve.ts';
import type { Tree } from './tree.ts';
import { parseTs } from './ts-parse.ts';
import { TsResolver } from './ts-resolve.ts';
import type { Language, Unavailable } from './types.ts';

function tsEdges(resolver: TsResolver, path: string, imports: RawImport[], syms: Sym[]): Edge[] {
  const edges = new Map<string, Edge>();
  for (const imp of imports) {
    const to = resolver.resolve(path, imp.spec);
    if (to && to !== path) mergeEdge(edges, { to, names: [...imp.names], whole: imp.whole, via: [imp.spec], testOnly: false });
  }
  for (const s of syms) {
    if (!s.reexport) continue;
    const to = resolver.resolve(path, s.reexport.spec);
    if (to && to !== path) s.reexport.to = to;
  }
  return [...edges.values()];
}

/** Add an edge to the declaring file for each name that reaches it through re-exports. */
function trace(nodes: Map<string, FileNode>): void {
  for (const node of nodes.values()) {
    const extra = new Map<string, Edge>();
    for (const e of node.edges) {
      const target = nodes.get(e.to);
      if (!target) continue;
      for (const name of e.names) {
        const origin = originOf(nodes, e.to, name);
        if (!origin) { (e.unresolved ??= []).push(name); continue; }
        if (origin.file === e.to || origin.file === node.path) continue;
        mergeEdge(extra, { to: origin.file, names: origin.name === '*' ? [] : [origin.name], whole: origin.name === '*', via: [...e.via], testOnly: e.testOnly, traced: true });
      }
      if (e.whole) for (const to of starTargets(nodes, e.to)) if (to !== node.path) mergeEdge(extra, { to, names: [], whole: true, via: [...e.via], testOnly: e.testOnly, traced: true });
    }
    const direct = new Map(node.edges.map((e) => [e.to, e]));
    for (const e of extra.values()) {
      const cur = direct.get(e.to);
      if (cur) mergeEdge(direct, { ...e, traced: cur.traced }); else node.edges.push(e);
    }
  }
}

export function buildGraph(tree: Tree, detail: (path: string) => boolean = () => false): Graph {
  const nodes = new Map<string, FileNode>();
  const unavailable: Unavailable[] = [];
  const languages = new Set<Language>();
  const rustReason = rustUnavailable();
  if (rustReason) unavailable.push({ tool: 'ast-grep:rust', reason: rustReason });
  const tsImports = new Map<string, RawImport[]>();
  const rustParsed = new Map<string, ParsedRust>();
  let failures = 0;

  for (const path of tree.files) {
    const language = languageOf(path);
    if (!language || isSkipped(path) || (language === 'rust' && rustReason) || tree.size(path) > MAX_PARSE_BYTES) continue;
    const text = tree.read(path);
    if (text === undefined) continue;
    try {
      if (language === 'rust') {
        const parsed = parseRust(text, detail(path));
        rustParsed.set(path, parsed);
        nodes.set(path, { path, language, isTest: false, syms: parsed.syms, edges: [] });
      } else {
        const parsed = parseTs(path, text, detail(path));
        tsImports.set(path, parsed.imports);
        nodes.set(path, { path, language, isTest: isTestPath(path), syms: parsed.syms, edges: [] });
      }
      languages.add(language);
    } catch { failures++; }
  }
  if (failures) unavailable.push({ tool: 'ast-grep', reason: `${failures} file(s) failed to parse and were skipped` });

  const ts = new TsResolver(tree);
  const rust = new RustWorkspace(tree, (f) => rustParsed.get(f));
  for (const [path, imports] of tsImports) {
    const node = nodes.get(path)!;
    node.edges = tsEdges(ts, path, imports, node.syms);
  }
  for (const [path, parsed] of rustParsed) {
    const node = nodes.get(path)!;
    node.isTest = rust.isTestFile(path);
    node.syms.push(...rust.reexports(path, parsed));
    node.edges = rust.edges(path, parsed);
  }
  trace(nodes);

  const rev = new Map<string, InEdge[]>();
  for (const node of nodes.values()) {
    for (const edge of node.edges) {
      const list = rev.get(edge.to);
      if (list) list.push({ from: node.path, edge }); else rev.set(edge.to, [{ from: node.path, edge }]);
    }
  }

  return {
    nodes, rev, unavailable,
    languages: [...languages].sort(),
    packages: [...ts.packageInfos(), ...rust.packageInfos()],
    resolveOther(path, text) {
      const language = languageOf(path);
      try {
        if (language === 'rust') {
          if (rustReason) return null;
          const parsed = parseRust(text, true);
          return { syms: [...parsed.syms, ...rust.reexports(path, parsed)], targets: rust.edges(path, parsed).map((e) => e.to) };
        }
        if (!language) return null;
        const parsed = parseTs(path, text, true);
        return { syms: parsed.syms, targets: tsEdges(ts, path, parsed.imports, parsed.syms).map((e) => e.to) };
      } catch { return null; }
    },
  };
}

/** Files that reach any seed through imports, with the fewest hops. Seeds are at depth 0. */
export function reverseReach(graph: Graph, seeds: Iterable<string>, depth: number): Map<string, number> {
  const dist = new Map<string, number>();
  let frontier: string[] = [];
  for (const s of seeds) { dist.set(s, 0); frontier.push(s); }
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next: string[] = [];
    for (const f of frontier) {
      for (const { from } of graph.rev.get(f) ?? []) {
        if (!dist.has(from)) { dist.set(from, d); next.push(from); }
      }
    }
    frontier = next;
  }
  return dist;
}
