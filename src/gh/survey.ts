// What a repository with history looks like before it moves onto gh-wat-dis: what the open issues
// lack, which labels are outside the plan, what the milestones carry. Facts only. Which bodies
// to rewrite is a person's call, so a body gets a description here and never a rating.

import { byVersion, doneWhen } from './milestone.ts';
import { issueRows } from './issues.ts';
import type { IssueRow, RawListIssue } from './issues.ts';
import { planLabels } from './labels.ts';
import type { LiveLabel } from './labels.ts';
import type { Config } from '../cli/config.ts';

export interface RawSurveyIssue extends RawListIssue { body: string | null; user: { login: string } | null }
export interface RawMilestone { title: string; number: number; state: string; description: string | null; due_on: string | null; open_issues: number; closed_issues: number }

export interface BodyFacts {
  chars: number;
  opensWithHeading: boolean;
  /** Headings that are section names in the issue format, in the order they appear. */
  sections: string[];
  otherHeadings: number;
  /** Task items another person may have checked. A rewrite must keep them. */
  checkedTasks: number;
  openTasks: number;
  agentContext: boolean;
}

export interface SurveyRow extends IssueRow {
  author: string;
  /** True when the signed-in user wrote the issue. */
  mine: boolean;
  body: BodyFacts;
}

export interface Survey {
  repo: string;
  owner: 'organization' | 'user';
  viewer: { login: string; permission: string };
  types: { source: 'issue-type' | 'label'; names: string[] };
  /** Open pull requests are counted and never listed: a migration leaves them alone. */
  counts: { openIssues: number; openPrs: number; byViewer: number; byOthers: number; noType: number; severalTypes: number; noSurface: number; noPriority: number; noSize: number; noMilestone: number; tracking: number };
  bodies: { empty: number; opensWithHeading: number; noFormatSection: number; withCheckedTasks: number };
  labels: {
    /** Surface labels in the config. Zero means no issue can have a surface yet. */
    surfaces: number;
    create: string[];
    update: string[];
    /** Labels outside the plan. `type` is the issue type the name stands for, and `untyped` counts the open issues that carry the label and have no type. */
    other: { name: string; description: string; color: string; openIssues: number; type: string | null; untyped: number }[];
  };
  /** Open milestones, lowest version first: the order a migration works through them. */
  milestones: { title: string; number: number; current: boolean; /** Open issues, without pull requests and the tracking issue. */ open: number; dueOn: string | null; description: boolean; doneWhen: number; tracking: number | null }[];
}

export interface SurveyInput {
  repo: string;
  organization: boolean;
  viewer: { login: string; permission: string };
  cfg: Config;
  issues: RawSurveyIssue[];
  labels: LiveLabel[];
  milestones: RawMilestone[];
}

const FORMAT_SECTIONS = ['System', 'Change', 'Do', 'Risks', 'Evidence', 'Unknowns'];
/** Label names that teams use for a type. The person confirms each one before a type is set from it. */
const TYPE_WORDS: Record<string, string> = {
  bug: 'Bug', defect: 'Bug', enhancement: 'Feature', feature: 'Feature', 'feature request': 'Feature', 'feature-request': 'Feature', task: 'Task', chore: 'Task',
};

export function bodyFacts(body: string | null): BodyFacts {
  const text = (body ?? '').replace(/\r/g, '').trim();
  const facts: BodyFacts = { chars: [...text].length, opensWithHeading: false, sections: [], otherHeadings: 0, checkedTasks: 0, openTasks: 0, agentContext: /<summary>[^<]*Agent context\s*<\/summary>/i.test(text) };
  let fence = false, first = true;
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (/^(```|~~~)/.test(l)) { fence = !fence; first = false; continue; }
    if (fence || !l) continue;
    const h = l.match(/^#{1,6}\s+(.*?)\s*#*$/);
    if (h) {
      if (first) facts.opensWithHeading = true;
      const name = FORMAT_SECTIONS.find((s) => s.toLowerCase() === h[1]!.toLowerCase());
      if (name) facts.sections.push(name); else facts.otherHeadings++;
    }
    const task = l.match(/^(?:[-*+]|\d+\.)\s+\[([ xX])\]/);
    if (task) task[1] === ' ' ? facts.openTasks++ : facts.checkedTasks++;
    first = false;
  }
  return facts;
}

/** Issue numbers from a working file: one at the start of each line, with or without "#". The rest of a line is a note. */
export function issueNumbers(text: string): number[] {
  return text.split('\n').map((l) => Number(l.match(/^\s*#?(\d+)\b/)?.[1])).filter((n) => n > 0);
}

/** One row for each open issue, in the order a migration works: the current milestone first, then later ones, then the backlog, newest update first. */
export function surveyRows(input: Pick<SurveyInput, 'cfg' | 'issues' | 'milestones' | 'viewer'>): SurveyRow[] {
  const raw = new Map(input.issues.map((i) => [i.number, i]));
  const order = input.milestones.filter((m) => m.state === 'open').map((m) => m.title).sort(byVersion);
  const rank = (m: string | null): number => { const i = m === null ? -1 : order.indexOf(m); return i < 0 ? order.length : i; };
  const me = input.viewer.login.toLowerCase();
  return issueRows(input.cfg, input.issues).map((r): SurveyRow => {
    const i = raw.get(r.number)!;
    const author = i.user?.login ?? '';
    return { ...r, author, mine: author.toLowerCase() === me, body: bodyFacts(i.body) };
  }).sort((a, b) => rank(a.milestone) - rank(b.milestone) || b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number);
}

export function survey(input: SurveyInput): Survey {
  const { cfg } = input;
  const rows = surveyRows(input);
  const count = (f: (r: SurveyRow) => boolean): number => rows.filter(f).length;
  const plan = planLabels(cfg, input.labels);
  const typeNames = new Map(cfg.issues.types.map((t) => [t.toLowerCase(), t]));
  const open = input.milestones.filter((m) => m.state === 'open').sort((a, b) => byVersion(a.title, b.title));
  return {
    repo: input.repo,
    owner: input.organization ? 'organization' : 'user',
    viewer: input.viewer,
    types: { source: cfg.issues.typeSource, names: cfg.issues.types },
    counts: {
      openIssues: rows.length, openPrs: input.issues.filter((i) => i.pull_request).length,
      byViewer: count((r) => r.mine), byOthers: count((r) => !r.mine),
      noType: count((r) => r.missing.includes('type')), severalTypes: count((r) => r.missing.includes('one type')),
      noSurface: count((r) => !r.surfaces.length && !r.tracking), noMilestone: count((r) => r.milestone === null && !r.tracking),
      noPriority: count((r) => r.missing.includes('priority')), noSize: count((r) => r.missing.includes('size')),
      tracking: count((r) => r.tracking),
    },
    bodies: {
      empty: count((r) => r.body.chars === 0), opensWithHeading: count((r) => r.body.opensWithHeading),
      noFormatSection: count((r) => r.body.chars > 0 && !r.body.sections.length), withCheckedTasks: count((r) => r.body.checkedTasks > 0),
    },
    labels: {
      surfaces: cfg.labels.surfaces.length,
      create: plan.create.map((l) => l.name),
      update: plan.update.map((l) => l.name),
      other: plan.extra.map((l) => {
        const on = rows.filter((r) => r.otherLabels.some((n) => n.toLowerCase() === l.name.toLowerCase()));
        const type = typeNames.get((TYPE_WORDS[l.name.toLowerCase()] ?? '').toLowerCase()) ?? null;
        return { name: l.name, description: l.description, color: l.color, openIssues: on.length, type, untyped: type ? on.filter((r) => r.type === null).length : 0 };
      }).sort((a, b) => b.openIssues - a.openIssues || a.name.localeCompare(b.name)),
    },
    milestones: open.map((m, i) => ({
      // Counted the way the milestone tool counts: issues only, without the tracking issue. GitHub's own
      // open_issues also counts pull requests and the tracking issue, so the two tools would disagree.
      title: m.title, number: m.number, current: i === 0, open: rows.filter((r) => r.milestone === m.title && !r.tracking).length, dueOn: m.due_on,
      description: Boolean(m.description?.trim()), doneWhen: doneWhen(m.description).length,
      tracking: Number(m.description?.match(/tracking:\*{0,2}\s*#(\d+)/i)?.[1]) || null,
    })),
  };
}
