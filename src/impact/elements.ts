import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArchElement, ArchRelationship, Config } from '../cli/config.ts';
import { CONFIG_REL } from '../cli/util.ts';
import { MAP_ELEMENT_TYPES } from '../spec.ts';

const ELEMENT_TYPES: readonly string[] = MAP_ELEMENT_TYPES;
import type { ElementType } from '../spec.ts';
import { isSkipped, isTestPath, languageOf } from './classify.ts';
import { globToRegExp } from './glob.ts';
import type { PackageInfo } from './model.ts';
import type { ElementListing } from './types.ts';

export interface ElementMap {
  mapping: 'config' | 'workspace' | 'directory';
  defs: ElementListing[];
  relationships: ArchRelationship[];
  /** Files no config glob or workspace package claimed. */
  unmapped: string[];
  /** Element id for any path, including paths that no longer exist. */
  of(path: string): string;
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'root';
const validType = (t: unknown, fallback: ElementType): ElementType => (ELEMENT_TYPES.includes(t as string) ? (t as ElementType) : fallback);

export function loadArchitecture(root: string, read: (path: string) => string | undefined = (path) => readFileSync(join(root, path), 'utf8')): Config['architecture'] | null {
  try {
    const cfg = JSON.parse(read(CONFIG_REL) ?? 'null') as Partial<Config>;
    const els = cfg.architecture?.elements;
    if (!Array.isArray(els) || !els.some((e) => e && e.id && Array.isArray(e.paths) && e.paths.length)) return null;
    return { system: cfg.architecture?.system ?? { name: '', description: '' }, elements: els.filter((e) => e && e.id), relationships: cfg.architecture?.relationships ?? [] };
  } catch { return null; }
}

export function buildElements(root: string, files: string[], packages: PackageInfo[], readConfig?: (path: string) => string | undefined): ElementMap {
  const arch = loadArchitecture(root, readConfig);
  const defs = new Map<string, ElementListing>();
  const globsHit = new Map<string, Set<string>>();
  const cache = new Map<string, string>();
  const unmapped: string[] = [];
  const add = (d: Omit<ElementListing, 'files' | 'globs'>): string => {
    let id = d.id;
    for (let n = 2; defs.has(id); n++) id = `${d.id}-${n}`;
    defs.set(id, { ...d, id, files: 0, globs: [] });
    return id;
  };

  const dirIds = new Map<string, string>();
  const directory = (name: string): string => {
    let id = dirIds.get(name);
    if (!id) {
      id = add({ id: slug(name), name: name || '(root)', type: 'component', technology: 'folder', found: 'directory', provenance: 'heuristic', source: 'git' });
      dirIds.set(name, id);
    }
    return id;
  };
  const topDir = (path: string): string => (path.includes('/') ? path.slice(0, path.indexOf('/')) : '');

  let claim: (path: string) => string | null;
  let fallback: (path: string) => string = (path) => directory(topDir(path));
  let mapping: ElementMap['mapping'];

  if (arch) {
    mapping = 'config';
    const rules: { id: string; glob: string; re: RegExp }[] = [];
    for (const e of arch.elements as ArchElement[]) {
      const id = add({
        id: e.id, name: e.name || e.id, type: validType(e.type, 'container'),
        ...(e.technology ? { technology: e.technology } : {}), ...(e.description ? { description: e.description } : {}),
        ...(e.parent ? { parent: e.parent } : {}), ...(e.external ? { external: true } : {}),
        found: 'config', provenance: 'exact', source: 'config',
      });
      for (const glob of e.paths ?? []) if (typeof glob === 'string') rules.push({ id, glob, re: globToRegExp(glob) });
    }
    claim = (path) => {
      const r = rules.find((x) => x.re.test(path));
      if (!r) return null;
      const hits = globsHit.get(r.id) ?? new Set<string>();
      globsHit.set(r.id, hits.add(r.glob));
      return r.id;
    };
  } else if (packages.length) {
    mapping = 'workspace';
    const pk = packages.map((p) => ({
      dir: p.dir,
      id: add({ id: slug(p.name), name: p.name, type: 'container', technology: p.kind === 'cargo' ? 'Rust crate' : 'npm package', found: 'workspace', provenance: 'heuristic', source: 'manifest' }),
    })).sort((a, b) => b.dir.length - a.dir.length);
    for (const p of pk) globsHit.set(p.id, new Set([p.dir ? `${p.dir}/**` : '**']));
    claim = (path) => pk.find((p) => !p.dir || path.startsWith(`${p.dir}/`))?.id ?? null;
  } else {
    mapping = 'directory';
    const code = files.filter((f) => languageOf(f) && !isSkipped(f) && !isTestPath(f));
    const tops = new Set(code.map(topDir));
    const only = tops.size === 1 ? [...tops][0]! : '';
    claim = () => null;
    if (only) {
      fallback = (path) => {
        if (!path.startsWith(`${only}/`)) return directory(topDir(path));
        const rest = path.slice(only.length + 1);
        return directory(rest.includes('/') ? `${only}/${rest.slice(0, rest.indexOf('/'))}` : only);
      };
    }
  }

  const of = (path: string): string => {
    let id = cache.get(path);
    if (id === undefined) {
      id = claim(path) ?? fallback(path);
      cache.set(path, id);
    }
    return id;
  };
  for (const f of files) {
    if (mapping !== 'directory' && claim(f) === null) unmapped.push(f);
    defs.get(of(f))!.files++;
  }
  for (const d of defs.values()) d.globs = [...(globsHit.get(d.id) ?? [])];
  return { mapping, get defs() { return [...defs.values()]; }, relationships: arch?.relationships ?? [], unmapped, of };
}
