// The numbers for a milestone status. Milestones have no due dates here: the lowest open
// milestone is the current one and is always due now, so status comes from movement and blockers.

export interface RawIssue {
  number: number; title: string; state: string; closed_at: string | null; updated_at: string;
  pull_request?: unknown; sub_issues_summary?: { total: number };
}
export interface Blocker { number: number; title: string; state: string; inMilestone: boolean }
export interface OpenIssue { number: number; title: string; blockedBy: Blocker[]; inReview: number[] }
export type MilestoneState = 'done' | 'blocked' | 'stalled' | 'moving';

export interface MilestoneStatus {
  milestone: { title: string; number: number; state: string; current: boolean };
  /** The issue whose sub-issues are the milestone's work. It is not counted as work. */
  tracking: number | null;
  /** `description`: the milestone names it on a Tracking line. `sub-issues`: guessed as the issue with the most sub-issues. */
  trackingFrom: 'description' | 'sub-issues' | null;
  /** Issues only. Pull requests and the tracking issue are left out. */
  counts: { total: number; closed: number; open: number; inReview: number; blocked: number; blockedOutside: number; closedLast7Days: number };
  status: MilestoneState;
  /** Why the status is what it is, as one fact. */
  reason: string;
  daysSinceLastClose: number | null;
  doneWhen: string[];
  open: OpenIssue[];
  closed: { number: number; title: string; closedAt: string }[];
}

export interface MilestoneInput {
  milestone: { title: string; number: number; state: string; description: string | null };
  /** Titles of every open milestone, to decide which one is current. */
  openMilestones: string[];
  items: RawIssue[];
  blockedBy: Map<number, { number: number; title: string; state: string }[]>;
  /** Open pull requests with the issue numbers each one closes. */
  openPrs: { number: number; closes: number[] }[];
  now: Date;
  stalledAfterDays?: number;
}

const versionKey = (title: string): number[] => (title.match(/\d+/g) ?? []).map(Number);
/** Lowest version first, so "the next milestone" has one meaning. */
export function byVersion(a: string, b: string): number {
  const x = versionKey(a), y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return a.localeCompare(b);
}

export function doneWhen(description: string | null): string[] {
  const lines = (description ?? '').split('\n');
  const start = lines.findIndex((l) => /done when/i.test(l));
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    const m = l.match(/^\s*[-*]\s+(.*)$/);
    if (m) out.push(m[1]!.trim());
    else if (l.trim() && out.length) break;
  }
  return out;
}

export function milestoneStatus(input: MilestoneInput): MilestoneStatus {
  const { milestone, items, blockedBy, openPrs, now } = input;
  const stalledAfter = input.stalledAfterDays ?? 7;
  const issues = items.filter((i) => !i.pull_request);
  const named = Number(milestone.description?.match(/tracking:\*{0,2}\s*#(\d+)/i)?.[1]);
  const fromLine = named && issues.some((i) => i.number === named) ? named : undefined;
  const tracking = fromLine
    ?? issues.filter((i) => (i.sub_issues_summary?.total ?? 0) > 0).sort((a, b) => b.sub_issues_summary!.total - a.sub_issues_summary!.total)[0]?.number
    ?? null;
  const work = issues.filter((i) => i.number !== tracking);
  const inMilestone = new Set(work.map((i) => i.number));
  const day = 86400000;

  const open: OpenIssue[] = work.filter((i) => i.state === 'open').map((i) => ({
    number: i.number, title: i.title,
    blockedBy: (blockedBy.get(i.number) ?? []).filter((b) => b.state === 'open')
      .map((b) => ({ number: b.number, title: b.title, state: b.state, inMilestone: inMilestone.has(b.number) })),
    inReview: openPrs.filter((p) => p.closes.includes(i.number)).map((p) => p.number),
  })).sort((a, b) => a.number - b.number);
  const closed = work.filter((i) => i.state === 'closed' && i.closed_at)
    .map((i) => ({ number: i.number, title: i.title, closedAt: i.closed_at! }))
    .sort((a, b) => b.closedAt.localeCompare(a.closedAt));

  const last = closed[0] ? Math.floor((now.getTime() - Date.parse(closed[0].closedAt)) / day) : null;
  const outside = open.filter((o) => o.blockedBy.some((b) => !b.inMilestone));
  const blocked = open.filter((o) => o.blockedBy.length);
  const free = open.filter((o) => !o.blockedBy.length);

  let status: MilestoneState, reason: string;
  if (!open.length && work.length) { status = 'done'; reason = `All ${work.length} issues are closed.`; }
  else if (outside.length) { status = 'blocked'; reason = `#${outside[0]!.number} waits on #${outside[0]!.blockedBy.find((b) => !b.inMilestone)!.number}, which is outside the milestone.`; }
  else if (open.length && !free.length) { status = 'blocked'; reason = `Every open issue waits on another one: ${blocked.map((o) => `#${o.number}`).join(', ')}.`; }
  else if (last !== null && last >= stalledAfter && !open.some((o) => o.inReview.length)) { status = 'stalled'; reason = `No issue closed in ${last} days and no pull request is open.`; }
  else if (last === null && !open.some((o) => o.inReview.length)) { status = 'stalled'; reason = 'No issue is closed and no pull request is open.'; }
  else { status = 'moving'; reason = last === null ? 'A pull request is open.' : `Last issue closed ${last === 0 ? 'today' : `${last} day${last === 1 ? '' : 's'} ago`}.`; }

  return {
    milestone: { title: milestone.title, number: milestone.number, state: milestone.state, current: [...input.openMilestones].sort(byVersion)[0] === milestone.title },
    tracking,
    trackingFrom: fromLine ? 'description' : tracking ? 'sub-issues' : null,
    counts: {
      total: work.length, closed: closed.length, open: open.length,
      inReview: open.filter((o) => o.inReview.length).length, blocked: blocked.length, blockedOutside: outside.length,
      closedLast7Days: closed.filter((c) => now.getTime() - Date.parse(c.closedAt) < 7 * day).length,
    },
    status, reason, daysSinceLastClose: last, doneWhen: doneWhen(milestone.description), open, closed,
  };
}
