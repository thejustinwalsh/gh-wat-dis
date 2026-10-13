// The fields triage needs for each open issue, and which of them are missing.

import { typeLabel } from '../cli/config.ts';
import type { Config } from '../cli/config.ts';

export interface RawListIssue {
  number: number; title: string; state: string; comments: number; updated_at: string;
  labels: { name: string }[]; milestone: { title: string } | null; type?: { name: string } | null;
  pull_request?: unknown; sub_issues_summary?: { total: number; completed: number };
}

export interface IssueRow {
  number: number;
  title: string;
  /** The issue type, or the type label on a repository that has no issue types. Null when unset. */
  type: string | null;
  surfaces: string[];
  agents: boolean;
  milestone: string | null;
  /** An issue whose work is its sub-issues. It needs no surface, size or priority. */
  tracking: boolean;
  subIssues: number;
  comments: number;
  updatedAt: string;
  /** What triage must set: "type", "one type" (it has several), "surface". An issue with no milestone is backlog, not missing. */
  missing: string[];
  /** Labels that are not a type, a surface or the agents label. */
  otherLabels: string[];
}

export function issueRows(cfg: Config, raw: RawListIssue[]): IssueRow[] {
  const byLabel = cfg.issues?.typeSource === 'label';
  // Where GitHub has issue types, a label named "bug" is one more label outside the plan.
  const typeNames = new Map(byLabel ? (cfg.issues?.types ?? []).map((t) => [typeLabel(t), t]) : []);
  const surfaceNames = new Set((cfg.labels?.surfaces ?? []).map((l) => l.name.toLowerCase()));
  const agentsName = (cfg.labels?.agents || 'agents').toLowerCase();
  return raw.filter((i) => !i.pull_request).map((i) => {
    const labels = i.labels.map((l) => l.name);
    const typeLabels = byLabel ? labels.filter((l) => typeNames.has(l.toLowerCase())) : [];
    const type = byLabel ? (typeLabels.length === 1 ? typeNames.get(typeLabels[0]!.toLowerCase())! : null) : (i.type?.name ?? null);
    const surfaces = labels.filter((l) => surfaceNames.has(l.toLowerCase()));
    const tracking = (i.sub_issues_summary?.total ?? 0) > 0;
    const missing: string[] = [];
    if (byLabel && typeLabels.length > 1) missing.push('one type');
    else if (!type) missing.push('type');
    if (!surfaces.length && !tracking && surfaceNames.size) missing.push('surface');
    return {
      number: i.number, title: i.title, type, surfaces, agents: labels.some((l) => l.toLowerCase() === agentsName),
      milestone: i.milestone?.title ?? null, tracking, subIssues: i.sub_issues_summary?.total ?? 0,
      comments: i.comments, updatedAt: i.updated_at, missing,
      otherLabels: labels.filter((l) => !typeNames.has(l.toLowerCase()) && !surfaceNames.has(l.toLowerCase()) && l.toLowerCase() !== agentsName),
    };
  }).sort((a, b) => b.number - a.number);
}
