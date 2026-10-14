import { posix } from 'node:path';
import { isTestPath } from './classify.ts';
import { globToRegExp } from './glob.ts';
import type { Edge, PackageInfo, Sym } from './model.ts';
import { mergeEdge } from './model.ts';
import type { ParsedRust, RawUse } from './rust-parse.ts';
import { parseToml, tomlTable } from './toml.ts';
import type { TomlTable } from './toml.ts';
import type { Tree } from './tree.ts';

interface Mod { file: string; prefix: string[]; children: Map<string, Mod>; parent: Mod | null; root: Mod; lib: string | null }
interface Crate { name: string; lib: string; dir: string; manifest: string; doc: TomlTable; deps: string[]; root: Mod | null }

const under = (dir: string, rel: string): string => posix.normalize(dir ? `${dir}/${rel}` : rel).replace(/\/$/, '');
const dirOf = (file: string): string => (posix.dirname(file) === '.' ? '' : posix.dirname(file));
const ident = (name: string): string => name.replace(/-/g, '_');

export class RustWorkspace {
  tree: Tree;
  crates: Crate[] = [];
  private libs = new Map<string, Crate>();
  private fileMod = new Map<string, Mod>();
  private parsed: (file: string) => ParsedRust | undefined;

  constructor(tree: Tree, parsed: (file: string) => ParsedRust | undefined) {
    this.tree = tree;
    this.parsed = parsed;
    this.findCrates();
    for (const c of this.crates) this.buildCrate(c);
  }

  private findCrates(): void {
    const docs = new Map<string, TomlTable>();
    for (const f of this.tree.files) {
      if (!/(^|\/)Cargo\.toml$/.test(f) || /(^|\/)(target|vendor|node_modules)\//.test(f)) continue;
      const text = this.tree.read(f);
      if (text !== undefined) docs.set(f, parseToml(text));
    }
    const members = new Set<string>();
    const shared = new Map<string, string>();
    let declared = false;
    for (const [file, doc] of docs) {
      const ws = tomlTable(doc.workspace);
      if (!doc.workspace) continue;
      const dir = dirOf(file);
      const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
      const include = list(ws.members).map((g) => globToRegExp(under(dir, g)));
      const exclude = list(ws.exclude).map((g) => globToRegExp(under(dir, g)));
      if (include.length) declared = true;
      members.add(file);
      for (const f of docs.keys()) if (include.some((re) => re.test(dirOf(f))) && !exclude.some((re) => re.test(dirOf(f)))) members.add(f);
      for (const [name, spec] of Object.entries(tomlTable(ws.dependencies))) {
        const p = tomlTable(spec).path;
        if (typeof p === 'string') shared.set(name, under(dir, p));
      }
    }
    const byDir = new Map<string, Crate>();
    for (const [file, doc] of docs) {
      const name = tomlTable(doc.package).name;
      if (typeof name !== 'string' || (declared && !members.has(file))) continue;
      const libName = tomlTable(doc.lib).name;
      const crate: Crate = { name, lib: ident(typeof libName === 'string' ? libName : name), dir: dirOf(file), manifest: file, doc, deps: [], root: null };
      this.crates.push(crate);
      byDir.set(crate.dir, crate);
      this.libs.set(crate.lib, crate);
    }
    for (const c of this.crates) {
      const tables = ['dependencies', 'dev-dependencies', 'build-dependencies'].map((s) => tomlTable(c.doc[s]));
      for (const t of Object.values(tomlTable(c.doc.target))) for (const s of ['dependencies', 'dev-dependencies', 'build-dependencies']) tables.push(tomlTable(tomlTable(t)[s]));
      for (const table of tables) {
        for (const [key, spec] of Object.entries(table)) {
          const t = tomlTable(spec);
          const pkg = typeof t.package === 'string' ? t.package : key;
          const dir = typeof t.path === 'string' ? under(c.dir, t.path) : t.workspace === true ? shared.get(key) : undefined;
          const target = dir !== undefined ? byDir.get(dir) : undefined;
          if (!target || target === c) continue;
          if (!c.deps.includes(target.name)) c.deps.push(target.name);
          if (ident(key) !== target.lib && pkg === target.name) this.libs.set(ident(key), target);
        }
      }
    }
  }

  packageInfos(): PackageInfo[] {
    return this.crates.map((c) => ({ kind: 'cargo', name: c.name, dir: c.dir, manifest: c.manifest, deps: c.deps }));
  }

  private buildCrate(c: Crate): void {
    const libPath = tomlTable(c.doc.lib).path;
    const lib = under(c.dir, typeof libPath === 'string' ? libPath : 'src/lib.rs');
    const roots: string[] = [];
    if (this.tree.has(lib)) roots.push(lib);
    const bins = Array.isArray(c.doc.bin) ? c.doc.bin.map((b) => tomlTable(b).path).filter((p): p is string => typeof p === 'string').map((p) => under(c.dir, p)) : [];
    const extra = /^(src\/main\.rs|src\/bin\/[^/]+\.rs|src\/bin\/[^/]+\/main\.rs|(tests|benches|examples)\/[^/]+\.rs|(tests|benches|examples)\/[^/]+\/main\.rs|build\.rs)$/;
    const pre = c.dir ? `${c.dir}/` : '';
    for (const f of this.tree.files) if (f.startsWith(pre) && (extra.test(f.slice(pre.length)) || bins.includes(f)) && !roots.includes(f)) roots.push(f);
    for (const file of roots) {
      if (this.fileMod.has(file)) continue;
      const root: Mod = { file, prefix: [], children: new Map(), parent: null, root: null as unknown as Mod, lib: c.lib };
      root.root = root;
      if (file === lib) c.root = root;
      this.fileMod.set(file, root);
      this.build(root, true);
    }
  }

  private build(mod: Mod, isRoot: boolean): void {
    const parsed = this.parsed(mod.file);
    if (!parsed) return;
    const base = posix.basename(mod.file, '.rs');
    const ownDir = isRoot || base === 'mod' ? dirOf(mod.file) : under(dirOf(mod.file), base);
    for (const m of parsed.mods) {
      if (m.modPath.join('::') !== mod.prefix.join('::') || mod.children.has(m.name)) continue;
      if (m.inline) {
        const child: Mod = { file: mod.file, prefix: [...mod.prefix, m.name], children: new Map(), parent: mod, root: mod.root, lib: mod.lib };
        mod.children.set(m.name, child);
        this.build(child, isRoot);
        continue;
      }
      const dir = mod.prefix.length ? under(ownDir, mod.prefix.join('/')) : ownDir;
      const cands = m.pathAttr ? [under(dirOf(mod.file), m.pathAttr)] : [under(dir, `${m.name}.rs`), under(dir, `${m.name}/mod.rs`)];
      const file = cands.find((f) => this.tree.has(f));
      if (!file || this.fileMod.has(file)) continue;
      const child: Mod = { file, prefix: [], children: new Map(), parent: mod, root: mod.root, lib: mod.lib };
      mod.children.set(m.name, child);
      this.fileMod.set(file, child);
      this.build(child, false);
    }
  }

  private modAt(file: string, modPath: string[]): Mod | null {
    let mod = this.fileMod.get(file) ?? null;
    for (const seg of modPath) mod = mod?.children.get(seg) ?? null;
    return mod;
  }

  private resolvePath(from: Mod, path: string[], inline: boolean): { mod: Mod; rest: string[] } | null {
    let i = 0;
    let mod: Mod | null = null;
    const first = path[0]!;
    if (first === 'crate') { mod = from.root; i = 1; } else if (first === 'self') { mod = from; i = 1; } else if (first === 'super') {
      mod = from;
      while (path[i] === 'super') { mod = mod?.parent ?? null; i++; }
    } else if (!inline && from.children.has(first)) mod = from;
    else if (this.libs.has(first)) { mod = this.libs.get(first)!.root; i = 1; }
    if (!mod) return null;
    while (i < path.length && mod.children.has(path[i]!)) mod = mod.children.get(path[i++]!)!;
    return { mod, rest: path.slice(i) };
  }

  private target(file: string, u: RawUse): { to: string; name: string | null; mod: Mod } | null {
    const from = this.modAt(file, u.modPath);
    if (!from || !u.path.length) return null;
    const r = this.resolvePath(from, u.path, !!u.inline);
    if (!r) return null;
    const name = u.glob || !r.rest.length ? null : [...r.mod.prefix, r.rest[0]!].join('::');
    return { to: r.mod.file, name, mod: r.mod };
  }

  /** `pub use` declarations as re-export symbols of the file that holds them. */
  reexports(file: string, parsed: ParsedRust): Sym[] {
    const out: Sym[] = [];
    for (const u of parsed.uses) {
      if (!u.pub) continue;
      const t = this.target(file, u);
      if (!t || (t.name === null && !u.glob)) continue;
      const prefix = u.modPath.length ? `${u.modPath.join('::')}::` : '';
      const local = u.glob ? '*' : `${prefix}${u.alias ?? u.path[u.path.length - 1]}`;
      if (t.to === file && (u.glob || t.name === local)) continue;
      const spec = u.path.join('::') + (u.glob ? '::*' : '');
      // The text is this one name, so a change to another name of the same `use` list leaves it alone.
      out.push({ name: local, kind: 'reexport', exported: true, start: u.line, end: u.line, header: `pub use ${spec}`, text: u.text ? `pub use ${spec}${u.alias ? ` as ${u.alias}` : ''}` : '', reexport: { spec, name: t.name ?? '*', to: t.to } });
    }
    return out;
  }

  /**
   * The imports of a file. A `pub use` of a module the file declares is structure, not an import: `mod foo;` and
   * `pub use foo::Bar` in lib.rs make the crate's front door, and an import line from lib.rs to each of its modules
   * would make it a hub that everything appears to import. The re-export stays a symbol, so a name used through it
   * is traced to the file that defines it.
   */
  edges(file: string, parsed: ParsedRust): Edge[] {
    const edges = new Map<string, Edge>();
    for (const u of parsed.uses) {
      const t = this.target(file, u);
      if (!t || t.to === file) continue;
      if (u.pub && this.inside(t.mod, this.modAt(file, u.modPath))) continue;
      mergeEdge(edges, { to: t.to, names: t.name ? [t.name] : [], whole: t.name === null, via: [u.path.join('::') + (u.glob ? '::*' : '')], testOnly: u.test });
    }
    return [...edges.values()];
  }

  /** True when `mod` is `owner` or a module declared under it. */
  private inside(mod: Mod, owner: Mod | null): boolean {
    for (let m: Mod | null = mod; m; m = m.parent) if (m === owner) return true;
    return false;
  }

  isTestFile(file: string): boolean {
    return isTestPath(file) || this.crates.some((c) => file.startsWith(c.dir ? `${c.dir}/` : '') && /^(tests|benches)\//.test(file.slice(c.dir ? c.dir.length + 1 : 0)));
  }
}
