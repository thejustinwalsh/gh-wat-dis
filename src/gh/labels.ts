// Labels mean two things: "agents", and the product surface an issue touches.
// Type is a GitHub issue type and priority is a person's call, so neither is a label.

import { AGENTS_LABEL, SURFACE_COLOR, proposeSurfaces } from '../cli/config.ts';
import type { Config } from '../cli/config.ts';

export interface LiveLabel { name: string; description: string; color: string }
export interface WantedLabel extends LiveLabel { role: 'agents' | 'surface' }
export interface LabelPlan {
  /** Where the surface list came from: the config, or a proposal from the architecture map. */
  surfacesFrom: 'config' | 'architecture' | 'none';
  create: WantedLabel[];
  update: (WantedLabel & { was: Pick<LiveLabel, 'description' | 'color'> })[];
  keep: string[];
  /** Labels on GitHub that the plan does not use. Never removed without --prune. */
  extra: LiveLabel[];
}

export function wantedLabels(cfg: Config): { labels: WantedLabel[]; surfacesFrom: LabelPlan['surfacesFrom'] } {
  const configured = cfg.labels?.surfaces ?? [];
  const surfaces = configured.length ? configured : proposeSurfaces(cfg);
  const agents = cfg.labels?.agents || AGENTS_LABEL.name;
  return {
    surfacesFrom: configured.length ? 'config' : surfaces.length ? 'architecture' : 'none',
    labels: [
      { role: 'agents', name: agents, description: AGENTS_LABEL.description, color: AGENTS_LABEL.color },
      ...surfaces.map((l): WantedLabel => ({ role: 'surface', name: l.name, description: l.description.slice(0, 100), color: SURFACE_COLOR })),
    ],
  };
}

export function planLabels(cfg: Config, live: LiveLabel[]): LabelPlan {
  const { labels, surfacesFrom } = wantedLabels(cfg);
  const byName = new Map(live.map((l) => [l.name.toLowerCase(), l]));
  const plan: LabelPlan = { surfacesFrom, create: [], update: [], keep: [], extra: [] };
  for (const want of labels) {
    const have = byName.get(want.name.toLowerCase());
    if (!have) plan.create.push(want);
    else if (have.description !== want.description || have.color.toLowerCase() !== want.color) plan.update.push({ ...want, was: { description: have.description, color: have.color } });
    else plan.keep.push(want.name);
  }
  const wanted = new Set(labels.map((l) => l.name.toLowerCase()));
  plan.extra = live.filter((l) => !wanted.has(l.name.toLowerCase()));
  return plan;
}
