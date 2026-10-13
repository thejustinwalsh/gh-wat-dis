import type { Language, Unavailable } from './types.ts';

/** A declaration in a file. `text` and `header` are filled only when the file was parsed with detail. */
export interface Sym {
  name: string;
  kind: string;
  exported: boolean;
  start: number;
  end: number;
  header: string;
  text: string;
  container?: string;
  /** Set on a re-export: the name it has in the module it comes from. "*" is the whole module. */
  reexport?: { spec: string; name: string; to?: string };
}

/** An import as written, before resolution. */
export interface RawImport {
  spec: string;
  names: string[];
  /** Namespace, glob, require or dynamic import: the module is used without naming a symbol. */
  whole: boolean;
  test?: boolean;
}

export interface Edge {
  to: string;
  names: string[];
  whole: boolean;
  via: string[];
  /** The import sits in test-only code, such as a Rust `#[cfg(test)]` module. */
  testOnly: boolean;
  /** Found by following re-exports from the file the import names. */
  traced?: boolean;
  /** Names the target file does not export on this side. */
  unresolved?: string[];
}

export interface FileNode {
  path: string;
  language: Language;
  isTest: boolean;
  syms: Sym[];
  edges: Edge[];
}

export interface InEdge { from: string; edge: Edge }

export interface PackageInfo {
  kind: 'npm' | 'cargo';
  name: string;
  dir: string;
  manifest: string;
  /** Names of other packages in this repo that the manifest declares. */
  deps: string[];
}

export interface Graph {
  nodes: Map<string, FileNode>;
  rev: Map<string, InEdge[]>;
  packages: PackageInfo[];
  languages: Language[];
  unavailable: Unavailable[];
  /** Resolve the imports of file content that is not on this side, such as the base version of a changed file. */
  resolveOther(path: string, text: string): { syms: Sym[]; targets: string[]; edges: Edge[] } | null;
}

export function mergeEdge(edges: Map<string, Edge>, e: Edge): void {
  const cur = edges.get(e.to);
  if (!cur) { edges.set(e.to, e); return; }
  for (const n of e.names) if (!cur.names.includes(n)) cur.names.push(n);
  for (const v of e.via) if (!cur.via.includes(v)) cur.via.push(v);
  cur.whole ||= e.whole;
  cur.testOnly &&= e.testOnly;
  if (cur.traced && !e.traced) delete cur.traced;
}

/** Follow re-exports to the file that declares `name`. A name of "*" in the result means the whole module. */
export function originOf(nodes: Map<string, FileNode>, file: string, name: string, seen = new Set<string>()): { file: string; name: string } | null {
  const key = `${file}\0${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const node = nodes.get(file);
  if (!node) return null;
  const own = node.syms.find((s) => s.name === name && s.exported) ?? node.syms.find((s) => s.name === name);
  if (own && !own.reexport) return { file, name };
  if (own?.reexport?.to) {
    return own.reexport.name === '*' ? { file: own.reexport.to, name: '*' } : originOf(nodes, own.reexport.to, own.reexport.name, seen) ?? { file: own.reexport.to, name: own.reexport.name };
  }
  for (const star of node.syms) {
    if (star.name !== '*' || !star.reexport?.to) continue;
    const hit = originOf(nodes, star.reexport.to, name, seen);
    if (hit) return hit;
  }
  return null;
}

/** Files a module re-exports wholesale, followed transitively. */
export function starTargets(nodes: Map<string, FileNode>, file: string, out = new Set<string>()): Set<string> {
  for (const s of nodes.get(file)?.syms ?? []) {
    const to = s.reexport?.to;
    if (s.name === '*' && to && !out.has(to)) { out.add(to); starTargets(nodes, to, out); }
  }
  return out;
}
