import { posix } from 'node:path';
import { globToRegExp } from './glob.ts';
import { parseJson } from './manifests.ts';
import type { PackageInfo } from './model.ts';
import type { Tree } from './tree.ts';

const EXTS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const JS_TO_TS: Record<string, string[]> = { '.js': ['.ts', '.tsx', '.d.ts'], '.jsx': ['.tsx'], '.mjs': ['.mts', '.d.mts'], '.cjs': ['.cts', '.d.cts'] };
const CONDITIONS = ['source', 'types', 'import', 'default', 'require', 'node', 'browser'];

interface TsConfig { baseDir: string | null; pathsDir: string; paths: [string, string[]][] }
interface NpmPackage { name: string; dir: string; json: Record<string, unknown> }

/** JSON with comments and trailing commas, as tsconfig files allow. */
export function parseJsonc(text: string | undefined): Record<string, unknown> | null {
  if (text === undefined) return null;
  const clean = text.replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m[0] === '"' ? m : '')).replace(/,(\s*[}\]])/g, '$1');
  return parseJson(clean);
}

const norm = (p: string): string => posix.normalize(p).replace(/^\.\//, '').replace(/\/$/, '');
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function flatten(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => flatten(v, out));
  else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const k of [...CONDITIONS, ...Object.keys(obj).filter((x) => !CONDITIONS.includes(x))]) if (k in obj) flatten(obj[k], out);
  }
  return out;
}

export class TsResolver {
  tree: Tree;
  packages: NpmPackage[] = [];
  private configs = new Map<string, TsConfig | null>();
  private cache = new Map<string, string | null>();

  constructor(tree: Tree) {
    this.tree = tree;
    this.findWorkspaces();
  }

  private findWorkspaces(): void {
    const manifests = this.tree.files.filter((f) => /(^|\/)package\.json$/.test(f) && !/(^|\/)node_modules\//.test(f));
    const dirs = new Map(manifests.map((f) => [posix.dirname(f) === '.' ? '' : posix.dirname(f), f]));
    const members = new Set<string>();
    for (const [dir, file] of dirs) {
      const json = parseJson(this.tree.read(file));
      const ws = json?.workspaces;
      const globs = strings(Array.isArray(ws) ? ws : (ws as { packages?: unknown } | undefined)?.packages);
      const yaml = this.tree.read(dir ? `${dir}/pnpm-workspace.yaml` : 'pnpm-workspace.yaml');
      if (yaml) {
        const block = /^packages:\s*\n((?:[ \t]+-.*\n?|[ \t]*#.*\n?|\s*\n)*)/m.exec(yaml)?.[1] ?? '';
        for (const m of block.matchAll(/^[ \t]+-\s*['"]?([^'"\n#]+?)['"]?\s*(?:#.*)?$/gm)) globs.push(m[1]!);
      }
      const include = globs.filter((g) => !g.startsWith('!')).map((g) => globToRegExp(norm(posix.join(dir, g))));
      const exclude = globs.filter((g) => g.startsWith('!')).map((g) => globToRegExp(norm(posix.join(dir, g.slice(1)))));
      for (const d of dirs.keys()) if (d !== dir && include.some((re) => re.test(d)) && !exclude.some((re) => re.test(d))) members.add(d);
    }
    for (const dir of members) {
      const json = parseJson(this.tree.read(dirs.get(dir)!));
      if (json && typeof json.name === 'string') this.packages.push({ name: json.name, dir, json });
    }
    this.packages.sort((a, b) => b.name.length - a.name.length);
  }

  packageInfos(): PackageInfo[] {
    const names = new Set(this.packages.map((p) => p.name));
    return this.packages.map((p) => ({
      kind: 'npm', name: p.name, dir: p.dir, manifest: `${p.dir}/package.json`,
      deps: [...new Set(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
        .flatMap((s) => Object.keys((p.json[s] as Record<string, unknown> | undefined) ?? {})))].filter((d) => names.has(d) && d !== p.name),
    }));
  }

  private file(path: string): string | null {
    const p = norm(path);
    if (p.startsWith('..')) return null;
    if (this.tree.has(p)) return p;
    const ext = posix.extname(p);
    for (const alt of JS_TO_TS[ext] ?? []) if (this.tree.has(p.slice(0, -ext.length) + alt)) return p.slice(0, -ext.length) + alt;
    for (const e of EXTS) if (this.tree.has(p + e)) return p + e;
    for (const e of EXTS) if (this.tree.has(`${p}/index${e}`)) return `${p}/index${e}`;
    return null;
  }

  private config(dir: string): TsConfig | null {
    const hit = this.configs.get(dir);
    if (hit !== undefined) return hit;
    let found: TsConfig | null = null;
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const file = dir ? `${dir}/${name}` : name;
      if (this.tree.has(file)) { found = this.loadConfig(file, 1); break; }
    }
    if (!found && dir) found = this.config(posix.dirname(dir) === '.' ? '' : posix.dirname(dir));
    this.configs.set(dir, found);
    return found;
  }

  private loadConfig(file: string, follow: number): TsConfig | null {
    const json = parseJsonc(this.tree.read(file));
    if (!json) return null;
    const dir = posix.dirname(file) === '.' ? '' : posix.dirname(file);
    const co = (json.compilerOptions ?? {}) as { baseUrl?: unknown; paths?: unknown };
    const baseDir = typeof co.baseUrl === 'string' ? norm(posix.join(dir, co.baseUrl)) : null;
    const own: TsConfig = {
      baseDir: baseDir === '.' ? '' : baseDir,
      pathsDir: baseDir === null ? dir : baseDir === '.' ? '' : baseDir,
      paths: co.paths && typeof co.paths === 'object' ? Object.entries(co.paths as Record<string, unknown>).map(([k, v]) => [k, strings(v)]) : [],
    };
    const ext = Array.isArray(json.extends) ? json.extends[0] : json.extends;
    if (follow > 0 && typeof ext === 'string' && ext.startsWith('.')) {
      const target = norm(posix.join(dir, ext));
      const parent = this.loadConfig(this.tree.has(target) ? target : `${target}.json`, follow - 1);
      if (parent) {
        if (!own.paths.length) { own.paths = parent.paths; own.pathsDir = co.baseUrl === undefined ? parent.pathsDir : own.pathsDir; }
        if (own.baseDir === null) own.baseDir = parent.baseDir;
      }
    }
    own.paths.sort((a, b) => b[0].length - a[0].length);
    return own;
  }

  private viaPaths(cfg: TsConfig, spec: string): string | null {
    for (const [pattern, targets] of cfg.paths) {
      const star = pattern.indexOf('*');
      let captured: string | null = null;
      if (star < 0) { if (pattern === spec) captured = ''; } else {
        const pre = pattern.slice(0, star), post = pattern.slice(star + 1);
        if (spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length) captured = spec.slice(pre.length, spec.length - post.length);
      }
      if (captured === null) continue;
      for (const t of targets) {
        const hit = this.file(posix.join(cfg.pathsDir, t.replace('*', captured)));
        if (hit) return hit;
      }
    }
    return null;
  }

  private viaPackage(spec: string): string | null {
    const pkg = this.packages.find((p) => spec === p.name || spec.startsWith(`${p.name}/`));
    if (!pkg) return null;
    const sub = spec === pkg.name ? '.' : `./${spec.slice(pkg.name.length + 1)}`;
    const cands: string[] = [];
    const exp = pkg.json.exports;
    if (typeof exp === 'string') { if (sub === '.') cands.push(exp); } else if (exp && typeof exp === 'object') {
      const map = exp as Record<string, unknown>;
      if (Object.keys(map).some((k) => k.startsWith('.'))) {
        flatten(map[sub], cands);
        for (const [k, v] of Object.entries(map)) {
          const star = k.indexOf('*');
          if (star < 0 || !sub.startsWith(k.slice(0, star)) || !sub.endsWith(k.slice(star + 1))) continue;
          const captured = sub.slice(star, sub.length - (k.length - star - 1));
          cands.push(...flatten(v).map((t) => t.replace('*', captured)));
        }
      } else if (sub === '.') flatten(map, cands);
    }
    if (sub === '.') {
      for (const k of ['source', 'module', 'main', 'types', 'typings']) if (typeof pkg.json[k] === 'string') cands.push(pkg.json[k] as string);
      cands.push('src/index', 'index');
    } else cands.push(sub, `./src/${sub.slice(2)}`);
    for (const c of cands) {
      const direct = this.file(posix.join(pkg.dir, c));
      if (direct) return direct;
      const src = c.replace(/^(\.\/)?(dist|lib|build|out|esm|cjs)\//, 'src/').replace(/(\.d)?\.[cm]?[jt]sx?$/, '');
      const mapped = src !== c ? this.file(posix.join(pkg.dir, src)) : null;
      if (mapped) return mapped;
    }
    return null;
  }

  /** The repo file an import specifier points at, or null for anything outside the repo. */
  resolve(from: string, spec: string): string | null {
    const dir = posix.dirname(from) === '.' ? '' : posix.dirname(from);
    const key = `${spec.startsWith('.') ? dir : `~${dir}`}\0${spec}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    return this.lookup(dir, key, spec);
  }

  private lookup(dir: string, key: string, spec: string): string | null {
    const clean = spec.replace(/[?#].*$/, '');
    let hit: string | null = null;
    if (clean.startsWith('.')) hit = this.file(posix.join(dir, clean));
    else if (!clean.startsWith('/') && !/^(node|bun|npm|jsr|https?|data):/.test(clean)) {
      const cfg = this.config(dir);
      hit = (cfg ? this.viaPaths(cfg, clean) : null) ?? this.viaPackage(clean) ?? (cfg?.baseDir != null ? this.file(posix.join(cfg.baseDir, clean)) : null);
    }
    this.cache.set(key, hit);
    return hit;
  }
}
