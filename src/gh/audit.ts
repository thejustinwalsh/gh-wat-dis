// The maintenance checks that can be counted: each one reads what GitHub already holds and
// prints one finding for each item, with the measured value. A check that needs a person's or
// an agent's reading (is this comment a question, does this body state the problem) is named
// in `leftToAgent` and not run here. Nothing in this file writes.

import { UsageError } from '../cli/util.ts';
import type { Config } from '../cli/config.ts';
import { issueRows } from './issues.ts';
import type { RawListIssue } from './issues.ts';
import { planLabels } from './labels.ts';
import type { LiveLabel } from './labels.ts';
import { parseRefs } from './links.ts';
import { byVersion, issueUrl } from './milestone.ts';
import type { MilestoneStatus } from './milestone.ts';

export const CHECK_IDS = [
  'stale-issues', 'stale-prs', 'missing-fields', 'milestone-status', 'finished-milestone',
  'orphan-prs', 'done-but-open', 'labels', 'blocked-chains', 'milestone-description',
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export interface Finding {
  /** What the finding is about, as a person writes it: `#88`, a milestone title or a label name. */
  item: string;
  kind: 'issue' | 'pr' | 'milestone' | 'label';
  /** The issue or pull request number. Null for a milestone or a label. */
  number: number | null;
  title: string;
  /** The measured value, or null when the finding is a fact with no size. */
  value: number | null;
  unit: 'days' | 'issues' | null;
  reason: string;
}
export interface CheckResult { check: CheckId; title: string; finds: string; count: number; findings: Finding[] }
export interface AgentCheck { check: string; title: string; read: string }
export interface AuditReport {
  repo: string;
  at: string;
  currentMilestone: string | null;
  thresholds: { staleIssueDays: number; stalePrDays: number; stalledAfterDays: number };
  /** How many merged pull requests the done-but-open check read, newest first. */
  mergedPrsRead: number;
  count: number;
  checks: CheckResult[];
  leftToAgent: AgentCheck[];
}

export interface RawAuditIssue extends RawListIssue { issue_dependencies_summary?: { total_blocked_by: number } }
export interface RawBlocker { number: number; title: string; state: string; updated_at: string; created_at?: string }
export interface OpenPr { number: number; title: string; createdAt?: string; updatedAt: string; isDraft: boolean; closes: number[] }
export interface MergedPr { number: number; title: string; body: string | null; closes: number[] }

export interface AuditInput {
  repo: string;
  cfg: Config;
  now: Date;
  /** Titles of every open milestone. */
  openMilestones: string[];
  /** Open issues as the REST list returns them. Pull requests in the list are skipped. */
  issues: RawAuditIssue[];
  openPrs: OpenPr[];
  mergedPrs: MergedPr[];
  labels: LiveLabel[];
  /** One rated status for each open milestone. */
  milestones: MilestoneStatus[];
  /** Open issue number to the issues that block it, open and closed. */
  blockers: Map<number, RawBlocker[]>;
  checks?: CheckId[];
  stalledAfterDays?: number;
}

export const LEFT_TO_AGENT: AgentCheck[] = [
  { check: 'awaiting-author', title: 'Awaiting author', read: 'The last comment on an issue: a question from a maintainer with no reply in 14 days.' },
  { check: 'format-drift', title: 'Format drift', read: 'Each open issue body in the current milestone, against the issue format.' },
  { check: 'out-of-date-facts', title: 'Out-of-date facts', read: 'Statements in open issues of the current milestone that another issue, a merged pull request or the code now contradicts.' },
  { check: 'done-when', title: 'Done-when conditions', read: 'Each done-when condition of an open milestone, against the repository: can it still be checked?' },
  { check: 'refs-finished', title: 'Work a Refs pull request finished', read: 'Each merged pull request a done-but-open finding names with Refs: did it finish the issue?' },
];

/** `stale` selects stale-issues and stale-prs: a name matches a check id, or the part before a dash. */
export function selectChecks(list: string | undefined): CheckId[] {
  if (list === undefined) return [...CHECK_IDS];
  const out = new Set<CheckId>();
  for (const name of list.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const hit = CHECK_IDS.filter((id) => id === name || id.startsWith(`${name}-`));
    if (!hit.length) throw new UsageError(`no check "${name}". Checks: ${CHECK_IDS.join(', ')}`);
    for (const id of hit) out.add(id);
  }
  return CHECK_IDS.filter((id) => out.has(id));
}

const DAY = 86400000;
const days = (now: Date, iso: string): number => Math.floor((now.getTime() - Date.parse(iso)) / DAY);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const worstFirst = (a: Finding, b: Finding): number => (b.value ?? -1) - (a.value ?? -1) || (a.number ?? 0) - (b.number ?? 0);

export function audit(input: AuditInput): AuditReport {
  const { cfg, now } = input;
  const staleIssueDays = cfg.triage?.staleIssueDays ?? 60;
  const stalePrDays = cfg.triage?.stalePrDays ?? 14;
  const stalledAfterDays = input.stalledAfterDays ?? 7;
  const current = [...input.openMilestones].sort(byVersion)[0] ?? null;
  const issues = input.issues.filter((i) => !i.pull_request);
  const open = new Map(issues.map((i) => [i.number, i]));
  const issue = (n: number, title: string, value: number | null, unit: Finding['unit'], reason: string): Finding =>
    ({ item: `#${n}`, kind: 'issue', number: n, title, value, unit, reason });
  const pr = (p: { number: number; title: string }, value: number | null, reason: string): Finding =>
    ({ item: `#${p.number}`, kind: 'pr', number: p.number, title: p.title, value, unit: value === null ? null : 'days', reason });
  const milestone = (m: MilestoneStatus, value: number | null, unit: Finding['unit'], reason: string): Finding =>
    ({ item: m.milestone.title, kind: 'milestone', number: null, title: m.milestone.title, value, unit, reason });

  const run: Record<CheckId, () => { title: string; finds: string; findings: Finding[] }> = {
    'stale-issues': () => ({
      title: 'Stale issues', finds: `Open issues with no update in ${staleIssueDays} days.`,
      findings: issues.filter((i) => days(now, i.updated_at) >= staleIssueDays)
        .map((i) => issue(i.number, i.title, days(now, i.updated_at), 'days', `No update in ${days(now, i.updated_at)} days.`)),
    }),
    'stale-prs': () => ({
      title: 'Stale PRs', finds: `Open pull requests with no update in ${stalePrDays} days.`,
      findings: input.openPrs.filter((p) => days(now, p.updatedAt) >= stalePrDays)
        .map((p) => pr(p, days(now, p.updatedAt), `No update in ${days(now, p.updatedAt)} days${p.isDraft ? ', and it is a draft' : ''}.`)),
    }),
    'missing-fields': () => ({
      title: 'Missing fields', finds: 'Open issues with no type, surface, priority or size, or with more than one type, priority or size. A tracking issue needs a type only.',
      findings: issueRows(cfg, issues).filter((r) => r.missing.length)
        .map((r) => issue(r.number, r.title, null, null, `Missing: ${r.missing.join(', ')}.`)).sort((a, b) => a.number! - b.number!),
    }),
    // The current milestone is due now, so every rating but moving and done is a finding for it, not started included.
    // A later milestone that has not started is in its normal state.
    'milestone-status': () => ({
      title: 'Milestone rating', finds: `The current milestone rated stalled (no issue closed in ${stalledAfterDays} days), blocked, growing or not started. Each finding gives the signals that decided the rating.`,
      findings: input.milestones.filter((m) => m.milestone.current && m.rating !== 'moving' && m.rating !== 'done').map((m) => {
        const why = `${m.rating[0]!.toUpperCase()}${m.rating.slice(1)}. ${m.reason} Signals: ${m.signals.filter((s) => s.decides).map((s) => s.text).join(' ')}`;
        const added = m.signals.find((s) => s.name === 'addedLast7Days')?.value ?? null;
        if (m.rating === 'stalled') return milestone(m, m.daysSinceLastClose, m.daysSinceLastClose === null ? null : 'days', why);
        if (m.rating === 'blocked') return milestone(m, m.counts.blocked, 'issues', why);
        if (m.rating === 'growing') return milestone(m, added, 'issues', why);
        return milestone(m, m.counts.open, 'issues', why);
      }),
    }),
    'finished-milestone': () => ({
      title: 'Finished milestone left open', finds: 'Open milestones where every issue is closed.',
      findings: input.milestones.filter((m) => m.rating === 'done').map((m) => milestone(m, m.counts.closed, 'issues', m.reason)),
    }),
    'orphan-prs': () => ({
      title: 'Orphan PRs', finds: 'Open pull requests that close no issue.',
      findings: input.openPrs.filter((p) => !p.closes.length).map((p) => pr(p, null, 'Closes no issue.')),
    }),
    'done-but-open': () => {
      const findings: Finding[] = [];
      const linked = new Set<number>();
      for (const p of input.mergedPrs) for (const n of p.closes) {
        const i = open.get(n);
        if (!i || linked.has(n)) continue;
        linked.add(n);
        findings.push(issue(n, i.title, null, null, `Pull request #${p.number} is linked to it and merged.`));
      }
      const here = input.repo.toLowerCase();
      const named = new Map<number, number[]>();
      for (const p of input.mergedPrs) {
        const refs = parseRefs(p.body ?? '', { repo: input.repo }).mentions.filter((m) => m.repo.toLowerCase() === here && /\brefs\b/i.test(m.text ?? ''));
        for (const n of new Set(refs.map((r) => r.number))) {
          const i = open.get(n);
          // A tracking issue is named by every pull request of its sub-issues: Refs says nothing about it.
          const tracking = (i?.sub_issues_summary?.total ?? 0) > 0;
          if (i && !tracking && !linked.has(n) && current !== null && i.milestone?.title === current) named.set(n, [...(named.get(n) ?? []), p.number]);
        }
      }
      for (const [n, prs] of named) {
        findings.push(issue(n, open.get(n)!.title, null, null, `Merged ${prs.length === 1 ? 'pull request' : 'pull requests'} ${prs.sort((a, b) => a - b).map((x) => `#${x}`).join(', ')} ${prs.length === 1 ? 'names' : 'name'} it with Refs. Read ${prs.length === 1 ? 'it' : 'them'}: is the work finished?`));
      }
      return { title: 'Done but open', finds: 'Open issues whose linked pull request merged, and open issues in the current milestone that a merged pull request names with Refs.', findings: findings.sort((a, b) => a.number! - b.number!) };
    },
    labels: () => {
      const plan = planLabels(cfg, input.labels);
      const carried = (name: string): number => issues.filter((i) => i.labels.some((l) => l.name.toLowerCase() === name.toLowerCase())).length;
      const label = (name: string, value: number | null, reason: string): Finding => ({ item: name, kind: 'label', number: null, title: name, value, unit: value === null ? null : 'issues', reason });
      return {
        title: 'Label hygiene', finds: 'Labels the config wants and GitHub lacks, labels that drifted, and labels outside the plan.',
        findings: [
          ...plan.create.map((l) => label(l.name, null, `The config wants this ${l.role} label and GitHub has none.`)),
          ...plan.update.map((l) => label(l.name, null, `Drifted from the config: ${[l.was.color.toLowerCase() !== l.color ? `colour ${l.was.color} for ${l.color}` : '', l.was.description !== l.description ? 'another description' : ''].filter(Boolean).join(', ')}.`)),
          ...plan.extra.map((l) => label(l.name, carried(l.name), `Outside the plan. On ${plural(carried(l.name), 'open issue')}.`)),
        ],
      };
    },
    'blocked-chains': () => {
      const findings: Finding[] = [];
      for (const i of issues) for (const b of input.blockers.get(i.number) ?? []) {
        const idle = days(now, b.updated_at);
        if (b.state === 'closed') findings.push(issue(i.number, i.title, null, null, `Blocked by #${b.number}, which is closed.`));
        else if (idle >= staleIssueDays) findings.push(issue(i.number, i.title, idle, 'days', `Blocked by #${b.number}, which has no update in ${idle} days.`));
      }
      return { title: 'Blocked chains', finds: `Open issues blocked by a closed issue, or by one with no update in ${staleIssueDays} days.`, findings };
    },
    'milestone-description': () => ({
      title: 'Milestone description', finds: 'Open milestones whose description has no Tracking line, and a current milestone with no tracking issue.',
      findings: input.milestones.flatMap((m) => [
        ...(m.trackingFrom !== 'description' ? [milestone(m, null, null, m.tracking ? `The description has no Tracking line. #${m.tracking} looks like the tracking issue: it has the most sub-issues. The line to add: **Tracking:** ${issueUrl(input.repo, m.tracking)}` : 'The description has no Tracking line.')] : []),
        ...(m.milestone.current && m.tracking === null ? [milestone(m, null, null, 'The current milestone has no tracking issue.')] : []),
      ]),
    }),
  };

  const checks = (input.checks ?? [...CHECK_IDS]).map((id): CheckResult => {
    const r = run[id]();
    const sorted = id === 'stale-issues' || id === 'stale-prs' || id === 'blocked-chains' ? r.findings.sort(worstFirst) : r.findings;
    return { check: id, title: r.title, finds: r.finds, count: sorted.length, findings: sorted };
  });
  return {
    repo: input.repo, at: now.toISOString(), currentMilestone: current,
    thresholds: { staleIssueDays, stalePrDays, stalledAfterDays },
    mergedPrsRead: input.mergedPrs.length,
    count: checks.reduce((n, c) => n + c.count, 0),
    checks, leftToAgent: LEFT_TO_AGENT,
  };
}

/** The report as a table for a person: one block for each check, one line for each finding. */
export function auditText(r: AuditReport): string {
  const out = [`${r.repo}: ${plural(r.count, 'finding')} in ${plural(r.checks.length, 'check')}. Current milestone: ${r.currentMilestone ?? 'none'}.`, ''];
  for (const c of r.checks) {
    out.push(`${c.title} (${c.count})  [${c.check}]`);
    const width = Math.min(24, Math.max(0, ...c.findings.map((f) => f.item.length)));
    for (const f of c.findings) out.push(`  ${f.item.padEnd(width)}  ${f.reason}${f.kind === 'issue' || f.kind === 'pr' ? `  ${f.title}` : ''}`);
    if (!c.findings.length) out.push('  none');
  }
  out.push('', 'Left to the agent: the tool does not run these.');
  for (const a of r.leftToAgent) out.push(`  ${a.title}: ${a.read}`);
  return out.join('\n') + '\n';
}
