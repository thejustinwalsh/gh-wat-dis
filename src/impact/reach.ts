import { relative, resolve } from 'node:path';
import { loadCodeowners, ownersOf } from './codeowners.ts';
import { DEFAULT_DEPTH } from './analyze.ts';
import type { ElementMap } from './elements.ts';
import { buildElements } from './elements.ts';
import { buildGraph, reverseReach } from './graph.ts';
import type { Graph } from './model.ts';
import { repoTop, workingTree } from './tree.ts';
import type {
  ElementsResult, OwnerMatch, Provenance, ReachDependent, ReachMatch, ReachOptions, ReachResult, ReachTarget, TransitiveRollup,
} from './types.ts';

function rollup(els: ElementMap, dist: Map<string, number>): TransitiveRollup[] {
  const out = new Map<string, TransitiveRollup>();
  for (const [file, d] of dist) {
    if (d === 0) continue;
    const element = els.of(file);
    const r = out.get(element) ?? { element, count: 0, minDepth: d, provenance: 'measured' as const };
    r.count++;
    r.minDepth = Math.min(r.minDepth, d);
    out.set(element, r);
  }
  return [...out.values()].sort((a, b) => a.minDepth - b.minDepth || b.count - a.count || a.element.localeCompare(b.element));
}

function matchOf(graph: Graph, els: ElementMap, file: string, symbol: string | undefined, depth: number): ReachMatch {
  const sym = symbol === undefined ? undefined : graph.nodes.get(file)?.syms.find((s) => s.name === symbol);
  const name = sym?.container ?? symbol;
  const direct: ReachDependent[] = [];
  for (const { from, edge } of graph.rev.get(file) ?? []) {
    let provenance: Provenance;
    if (name === undefined) provenance = edge.names.length || !edge.whole ? 'resolved' : 'heuristic';
    else if (edge.names.includes(name)) provenance = sym?.container ? 'heuristic' : 'resolved';
    else if (edge.whole) provenance = 'heuristic';
    else continue;
    const node = graph.nodes.get(from)!;
    direct.push({ file: from, element: els.of(from), via: edge.via, isTest: node.isTest || edge.testOnly, depth: 1, provenance });
  }
  direct.sort((a, b) => a.file.localeCompare(b.file));
  const dist = reverseReach(graph, direct.map((d) => d.file), Math.max(depth - 1, 0));
  const shifted = new Map([...dist].filter(([f]) => f !== file).map(([f, d]) => [f, d + 1]));
  return { file, ...(symbol !== undefined ? { symbol, ...(sym ? { kind: sym.kind } : {}) } : {}), element: els.of(file), direct, transitive: rollup(els, shifted) };
}

export async function reachOf(opts: ReachOptions): Promise<ReachResult> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const root = await repoTop(cwd);
  const depth = opts.depth ?? DEFAULT_DEPTH;
  const tree = await workingTree(root);
  const graph = buildGraph(tree);
  const els = buildElements(root, tree.files, graph.packages);
  const asPath = (p: string): string | null => {
    for (const cand of [relative(root, resolve(cwd, p)), p.replace(/^\.\//, '')]) {
      const posixPath = cand.split('\\').join('/');
      if (tree.has(posixPath)) return posixPath;
    }
    return null;
  };

  const targets: ReachTarget[] = opts.targets.map((target) => {
    const hash = target.lastIndexOf('#');
    const matches: ReachMatch[] = [];
    if (hash > 0) {
      const file = asPath(target.slice(0, hash));
      if (file) matches.push(matchOf(graph, els, file, target.slice(hash + 1), depth));
    } else {
      const file = asPath(target);
      if (file) matches.push(matchOf(graph, els, file, undefined, depth));
      else {
        for (const node of graph.nodes.values()) {
          if (node.syms.some((s) => s.exported && !s.reexport && s.name === target)) matches.push(matchOf(graph, els, node.path, target, depth));
        }
      }
    }
    return { target, found: matches.length > 0, ambiguous: matches.length > 1, matches };
  });

  const caveats = ['dependents are files whose imports resolve to the target; calls through dependency injection, reflection, string paths or generated code are not seen'];
  const missing = targets.filter((t) => !t.found).map((t) => t.target);
  if (missing.length) caveats.push(`not a tracked file or an exported symbol: ${missing.join(', ')}`);
  return { schema: 1, depth, tiers: { ran: ['git', ...(graph.nodes.size ? ['ast-grep'] : [])], languages: graph.languages, unavailable: graph.unavailable }, targets, caveats };
}

export async function resolveOwners(opts: { cwd?: string; paths: string[] }): Promise<OwnerMatch[]> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const root = await repoTop(cwd);
  const tree = await workingTree(root);
  const co = loadCodeowners((p) => tree.read(p));
  return opts.paths.map((p) => {
    const rel = relative(root, resolve(cwd, p)).split('\\').join('/');
    return { ...ownersOf(co, rel.startsWith('..') ? p : rel), path: p };
  });
}

export async function listElements(opts: { cwd?: string } = {}): Promise<ElementsResult> {
  const root = await repoTop(resolve(opts.cwd ?? process.cwd()));
  const tree = await workingTree(root);
  const graph = buildGraph(tree);
  const els = buildElements(root, tree.files, graph.packages);
  return { schema: 1, mapping: els.mapping, elements: els.defs, unmapped: els.unmapped };
}
