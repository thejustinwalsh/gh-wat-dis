import { parseToml, tomlTable } from './toml.ts';
import type { TomlValue } from './toml.ts';
import type { DependencyFact } from './types.ts';

/** section -> dependency name -> version or source, as written in the manifest. */
export type DepMap = Map<string, Map<string, string>>;

const NPM_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const CARGO_SECTIONS = ['dependencies', 'dev-dependencies', 'build-dependencies'];

export function parseJson(text: string | undefined): Record<string, unknown> | null {
  if (text === undefined) return null;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

export function npmDeps(text: string | undefined): DepMap {
  const out: DepMap = new Map();
  const pkg = parseJson(text);
  for (const section of NPM_SECTIONS) {
    const deps = pkg?.[section];
    if (deps && typeof deps === 'object') out.set(section, new Map(Object.entries(deps as Record<string, unknown>).map(([k, v]) => [k, String(v)])));
  }
  return out;
}

export function cargoDepSpec(v: TomlValue): string {
  if (typeof v === 'string') return v;
  const t = tomlTable(v);
  const parts: string[] = [];
  if (typeof t.version === 'string') parts.push(t.version);
  if (t.workspace === true) parts.push('workspace');
  if (typeof t.path === 'string') parts.push(`path:${t.path}`);
  if (typeof t.git === 'string') parts.push(`git:${t.git}${typeof t.rev === 'string' ? `#${t.rev}` : typeof t.tag === 'string' ? `#${t.tag}` : typeof t.branch === 'string' ? `#${t.branch}` : ''}`);
  if (Array.isArray(t.features) && t.features.length) parts.push(`features:${t.features.join('+')}`);
  return parts.join(' ') || JSON.stringify(v);
}

export function cargoDeps(text: string | undefined): DepMap {
  const out: DepMap = new Map();
  if (text === undefined) return out;
  const doc = parseToml(text);
  const add = (section: string, table: TomlValue | undefined): void => {
    const entries = Object.entries(tomlTable(table));
    if (entries.length) out.set(section, new Map(entries.map(([k, v]) => [k, cargoDepSpec(v)])));
  };
  for (const s of CARGO_SECTIONS) add(s, doc[s]);
  add('workspace.dependencies', tomlTable(doc.workspace).dependencies);
  for (const [target, t] of Object.entries(tomlTable(doc.target))) for (const s of CARGO_SECTIONS) add(`target.${target}.${s}`, tomlTable(t)[s]);
  return out;
}

export const isManifest = (path: string): boolean => /(^|\/)(package\.json|Cargo\.toml)$/.test(path);

export function diffManifest(manifest: string, before: string | undefined, after: string | undefined): DependencyFact[] {
  const read = manifest.endsWith('Cargo.toml') ? cargoDeps : npmDeps;
  const a = read(before), b = read(after);
  const out: DependencyFact[] = [];
  for (const section of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(section) ?? new Map<string, string>(), y = b.get(section) ?? new Map<string, string>();
    for (const name of new Set([...x.keys(), ...y.keys()])) {
      const from = x.get(name), to = y.get(name);
      if (from === to) continue;
      const change = from === undefined ? 'added' : to === undefined ? 'removed' : 'bumped';
      out.push({ manifest, name, section, change, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}), provenance: 'exact' });
    }
  }
  return out.sort((p, q) => p.name.localeCompare(q.name));
}

/** The name a manifest gives its package, when it gives one. */
export function packageName(manifest: string, text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  if (manifest.endsWith('.json')) { try { const name = (JSON.parse(text) as { name?: unknown }).name; return typeof name === 'string' ? name : undefined; } catch { return undefined; } }
  const section = /^\s*\[package\]([\s\S]*?)(^\s*\[|$(?![\s\S]))/m.exec(text);
  return /^\s*name\s*=\s*"([^"]+)"/m.exec(section?.[1] ?? '')?.[1];
}
