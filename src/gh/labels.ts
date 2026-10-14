// Labels mean four things: "agents", the product surface an issue touches, its priority and its size.
// Type is a GitHub issue type where the repository has them (organizations). A repository under
// a user account has none, so there each type is a label too. A person decides the priority; its label records it.

import { AGENTS_LABEL, PRIORITY_LABELS, SIZE_LABELS, TYPE_LABELS, priorityNames, proposeSurfaces, sizeNames, typeLabel } from '../cli/config.ts';
import { ROLE_COLORS, priorityColor, sizeColor, surfaceColor } from './color.ts';
import type { Config } from '../cli/config.ts';

export interface LiveLabel { name: string; description: string; color: string }
export interface WantedLabel extends LiveLabel { role: 'type' | 'agents' | 'surface' | 'priority' | 'size' }
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
  const describe = (known: { name: string; description: string }[], name: string, i: number, kind: string): string => known.find((k) => k.name === name)?.description ?? known[i]?.description ?? `${kind}: ${name}`;
  const priorities = priorityNames(cfg);
  const sizes = sizeNames(cfg);
  return {
    surfacesFrom: configured.length ? 'config' : surfaces.length ? 'architecture' : 'none',
    labels: [
      ...(cfg.issues?.typeSource === 'label' ? (cfg.issues.types ?? []).map((t): WantedLabel => {
        const name = typeLabel(t);
        const color = (ROLE_COLORS as Record<string, string>)[name] ?? ROLE_COLORS.otherType;
        return { role: 'type', name, description: TYPE_LABELS[name]?.description ?? `Type: ${t}`, color };
      }) : []),
      { role: 'agents', name: agents, description: AGENTS_LABEL.description, color: ROLE_COLORS.agents },
      ...priorities.map((name, i): WantedLabel => ({ role: 'priority', name, description: describe(PRIORITY_LABELS, name, i, 'Priority'), color: priorityColor(i, priorities.length) })),
      ...sizes.map((name, i): WantedLabel => ({ role: 'size', name, description: describe(SIZE_LABELS, name, i, 'Size'), color: sizeColor(i, sizes.length) })),
      ...surfaces.map((l, i): WantedLabel => ({ role: 'surface', name: l.name, description: l.description.slice(0, 100), color: (l.color ?? surfaceColor(i)).replace(/^#/, '').toLowerCase() })),
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
