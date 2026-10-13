import { ELEMENT_TYPES } from '../spec.ts';
import type { ElementType } from '../spec.ts';

export const USE = ['always', 'ask', 'never'] as const;
export type Use = (typeof USE)[number];

export interface ArchElement {
  id: string;
  name: string;
  type?: ElementType;
  technology?: string;
  description?: string;
  parent?: string;
  external?: boolean;
  paths?: string[];
}

export interface ArchRelationship { from: string; to: string; label: string; technology?: string }

/** A label for a part of the product an issue touches. */
export interface SurfaceLabel { name: string; description: string; elements?: string[] }

export const AGENTS_LABEL = { name: 'agents', description: 'Agent memory, an agentic workflow, or work managed by autonomous agents', color: '5319e7' };
export const SURFACE_COLOR = 'c5def5';

export interface Config {
  $schema?: string;
  version: 1;
  policy: { use: Use; confirmBeforeWrite: boolean };
  repo: { owner: string; name: string; defaultBranch: string };
  /** `types` are GitHub issue types. `typeSource` is `none` when the repository has none (issue types belong to organizations). */
  issues: { types: string[]; typeSource: 'issue-type' | 'none' };
  /** Labels mean two things only: the agents label, and the product surface an issue touches. */
  labels: { agents: string; surfaces: SurfaceLabel[] };
  pulls: { draft: boolean; closingKeyword: string };
  milestones: { naming: string; capacity: number | null };
  triage: { staleIssueDays: number; stalePrDays: number };
  architecture: { system: { name: string; description: string }; elements: ArchElement[]; relationships: ArchRelationship[] };
}

export interface ConfigSeed {
  owner?: string;
  name?: string;
  defaultBranch?: string;
  use?: Use;
  issueTypes?: string[];
  milestones?: string[];
}

export function defaultConfig({ owner = '', name = '', defaultBranch = 'main', use = 'always', issueTypes = [], milestones = [] }: ConfigSeed = {}): Config {
  return {
    $schema: 'https://tjw.dev/gh-wat-dis/config.schema.json',
    version: 1,
    policy: { use, confirmBeforeWrite: true },
    repo: { owner, name, defaultBranch },
    issues: { types: issueTypes, typeSource: issueTypes.length ? 'issue-type' : 'none' },
    labels: { agents: AGENTS_LABEL.name, surfaces: [] },
    pulls: { draft: false, closingKeyword: 'Closes' },
    milestones: { naming: milestones[0] ? `like "${milestones[0]}"` : '', capacity: null },
    triage: { staleIssueDays: 60, stalePrDays: 14 },
    architecture: { system: { name, description: '' }, elements: [], relationships: [] },
  };
}

/** Checks a parsed config file. The input is untrusted JSON. */
export function validateConfig(input: unknown): string[] {
  const cfg = (input ?? {}) as Partial<Config>;
  const errors: string[] = [];
  if (cfg.version !== 1) errors.push('version must be 1');
  if (!USE.includes(cfg.policy?.use as Use)) errors.push(`policy.use must be one of ${USE.join(', ')}`);
  const els: unknown = cfg.architecture?.elements ?? [];
  if (!Array.isArray(els)) return [...errors, 'architecture.elements must be an array'];
  const ids = new Set<string>();
  for (const e of els as Partial<ArchElement>[]) {
    if (!e.id || !e.name) { errors.push(`architecture element needs id and name: ${JSON.stringify(e).slice(0, 60)}`); continue; }
    if (ids.has(e.id)) errors.push(`duplicate architecture element id "${e.id}"`);
    ids.add(e.id);
    if (e.type && !ELEMENT_TYPES.includes(e.type)) errors.push(`element "${e.id}" has unknown type "${e.type}"`);
    if (e.paths && !Array.isArray(e.paths)) errors.push(`element "${e.id}": paths must be an array of globs`);
  }
  for (const r of cfg.architecture?.relationships ?? []) {
    if (!ids.has(r.from) || !ids.has(r.to)) errors.push(`relationship ${r.from} -> ${r.to} names an unknown element`);
    if (!r.label) errors.push(`relationship ${r.from} -> ${r.to} needs a label`);
  }
  for (const l of cfg.labels?.surfaces ?? []) {
    if (!l.name) errors.push('a surface label needs a name');
    for (const e of l.elements ?? []) if (!ids.has(e)) errors.push(`surface label "${l.name}" names an unknown element "${e}"`);
  }
  return errors;
}

/** Surface labels to offer when the config has none: one for each part of the system that holds files. */
export function proposeSurfaces(cfg: Config): SurfaceLabel[] {
  return (cfg.architecture?.elements ?? [])
    .filter((e) => !e.external && e.type !== 'person' && e.type !== 'boundary' && e.type !== 'node' && (e.paths?.length ?? 0) > 0)
    .map((e) => ({ name: e.id, description: `${e.name}${e.description ? `: ${e.description}` : ''}`.slice(0, 100), elements: [e.id] }));
}
