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

export interface Config {
  $schema?: string;
  version: 1;
  policy: { use: Use; confirmBeforeWrite: boolean };
  repo: { owner: string; name: string; defaultBranch: string };
  issues: { types: string[]; priorities: string[]; defaultLabels: string[] };
  pulls: { draft: boolean; closingKeyword: string };
  milestones: { naming: string; capacity: number | null };
  triage: { staleIssueDays: number; stalePrDays: number; needsInfoLabel: string };
  architecture: { system: { name: string; description: string }; elements: ArchElement[]; relationships: ArchRelationship[] };
}

export interface ConfigSeed {
  owner?: string;
  name?: string;
  defaultBranch?: string;
  use?: Use;
  labels?: string[];
  milestones?: string[];
}

export function defaultConfig({ owner = '', name = '', defaultBranch = 'main', use = 'always', labels = [], milestones = [] }: ConfigSeed = {}): Config {
  const pick = (re: RegExp): string[] => labels.filter((l) => re.test(l));
  return {
    $schema: 'https://thejustinwalsh.github.io/gh-wat-dis/config.schema.json',
    version: 1,
    policy: { use, confirmBeforeWrite: true },
    repo: { owner, name, defaultBranch },
    issues: {
      types: pick(/^(type[:/ ]|bug$|feature$|enhancement$|task$|chore$|spike$|epic$|question$|documentation$)/i),
      priorities: pick(/^(p[0-4]$|priority[:/ ])/i),
      defaultLabels: [],
    },
    pulls: { draft: false, closingKeyword: 'Closes' },
    milestones: { naming: milestones[0] ? `like "${milestones[0]}"` : '', capacity: null },
    triage: { staleIssueDays: 60, stalePrDays: 14, needsInfoLabel: pick(/needs[- ]?(info|repro|more)/i)[0] ?? '' },
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
  return errors;
}
