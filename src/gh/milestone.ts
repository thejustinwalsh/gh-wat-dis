// The numbers for a milestone status. Milestones have no due dates here: the lowest open
// milestone is the current one and is always due now, so the rating comes from movement, blockers and scope.
// The rating never stands alone: every signal prints with its number, and the ones the rule used are marked.

export interface RawIssue {
  number: number; title: string; state: string; closed_at: string | null; updated_at: string; created_at?: string;
  pull_request?: unknown; sub_issues_summary?: { total: number };
}
export interface Blocker { number: number; title: string; state: string; inMilestone: boolean }
export interface OpenIssue { number: number; title: string; blockedBy: Blocker[]; inReview: number[] }
/** Checked in this order. The first rule that holds gives the rating. */
export type Rating = 'done' | 'not started' | 'blocked' | 'stalled' | 'growing' | 'moving';
/** One measured number. `value` is null when the tool could not measure it. `decides` marks the signals the rule used for this rating. */
export interface Signal { name: string; value: number | null; text: string; decides: boolean }
/** At this share of closed issues a milestone is near release, and new scope counts against it. */
export const SELECTIVE_AT = 50;

export interface MilestoneStatus {
  milestone: { title: string; number: number; state: string; current: boolean };
  /** The issue whose sub-issues are the milestone's work. It is not counted as work. */
  tracking: number | null;
  /** `description`: the milestone names it on a Tracking line. `sub-issues`: guessed as the issue with the most sub-issues. */
  trackingFrom: 'description' | 'sub-issues' | null;
  /** Issues only. Pull requests and the tracking issue are left out. */
  counts: { total: number; closed: number; open: number; inReview: number; blocked: number; blockedOutside: number; closedLast7Days: number };
  rating: Rating;
  /** Why the rating is what it is, as one fact. */
  reason: string;
  /** Every number behind the rating, so a reader can disagree with it. */
  signals: Signal[];
  daysSinceLastClose: number | null;
  doneWhen: string[];
  open: OpenIssue[];
  closed: { number: number; title: string; closedAt: string }[];
}

export interface MilestoneInput {
  /** `owner/name`. An issue URL in the description counts only when it points into this repository. */
  repo: string;
  milestone: { title: string; number: number; state: string; description: string | null };
  /** Titles of every open milestone, to decide which one is current. */
  openMilestones: string[];
  items: RawIssue[];
  blockedBy: Map<number, { number: number; title: string; state: string; created_at?: string }[]>;
  /** Open pull requests with the issue numbers each one closes. */
  openPrs: { number: number; closes: number[]; createdAt?: string }[];
  /** From each issue's timeline: when it joined this milestone, and how often it was reopened. Leave out when the timeline was not read. */
  events?: Map<number, { joinedAt: string | null; reopened: number }>;
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

/** The address of an issue: the form a milestone description names it in. */
export const issueUrl = (repo: string, n: number): string => `https://github.com/${repo}/issues/${n}`;

const REF = /https?:\/\/[^\s<>()\[\]]+|(?<![\w/.-])([\w.-]+\/[\w.-]+)?#(\d+)\b/g;
const ISSUE_URL = /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)(?![\w-])/i;
/**
 * The issues and pull requests of this repository that a text names, in the order it names them.
 * The format writes each one as its full URL, because GitHub links no `#n` in a milestone description.
 * `#n` and `owner/name#n` are read too, so a description written before that rule keeps working.
 * A reference into another repository is not counted.
 */
export function issueRefs(text: string | null, repo: string): number[] {
  const here = repo.toLowerCase();
  const out: number[] = [];
  for (const m of (text ?? '').matchAll(REF)) {
    if (m[2]) { if (!m[1] || m[1].toLowerCase() === here) out.push(Number(m[2])); continue; }
    const u = m[0].match(ISSUE_URL);
    if (u && u[1]!.toLowerCase() === here) out.push(Number(u[2]));
  }
  return out;
}

/** The issue a description names on its Tracking line, or null. */
export function trackingIn(description: string | null, repo: string): number | null {
  const line = description?.match(/tracking:\*{0,2}[ \t]*(\S+)/i)?.[1];
  return line ? issueRefs(line, repo)[0] ?? null : null;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const ago = (days: number): string => (days === 0 ? 'today' : `${plural(days, 'day')} ago`);

export function milestoneStatus(input: MilestoneInput): MilestoneStatus {
  const { milestone, items, blockedBy, openPrs, now } = input;
  const stalledAfter = input.stalledAfterDays ?? 7;
  const issues = items.filter((i) => !i.pull_request);
  const named = trackingIn(milestone.description, input.repo);
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

  const since = (iso: string | undefined): number | null => (iso ? Math.floor((now.getTime() - Date.parse(iso)) / day) : null);
  const oldest = (xs: (number | null)[]): number | null => { const ys = xs.filter((x): x is number => x !== null); return ys.length ? Math.max(...ys) : null; };
  const reviewed = open.filter((o) => o.inReview.length);
  const share = work.length ? Math.round((closed.length / work.length) * 100) : 0;
  const closed7 = closed.filter((c) => now.getTime() - Date.parse(c.closedAt) < 7 * day).length;
  const reviewAge = oldest(openPrs.filter((p) => p.closes.some((n) => open.some((o) => o.number === n))).map((p) => since(p.createdAt)));
  const blockerAge = oldest(work.filter((i) => i.state === 'open').flatMap((i) => (blockedBy.get(i.number) ?? []).filter((b) => b.state === 'open').map((b) => since(b.created_at))));

  // Scope: the milestone starts at its first close. An issue that joins after that is added scope.
  const start = closed.length ? closed[closed.length - 1]!.closedAt : null;
  const ev = input.events;
  const joined = ev && start ? work.map((i) => ev.get(i.number)?.joinedAt ?? i.created_at).filter((t): t is string => Boolean(t) && Date.parse(t!) > Date.parse(start)) : null;
  const added = ev ? (joined?.length ?? 0) : null;
  const added7 = ev ? (joined ?? []).filter((t) => now.getTime() - Date.parse(t) < 7 * day).length : null;
  const reopened = ev ? work.filter((i) => (ev.get(i.number)?.reopened ?? 0) > 0).length : null;

  // A done-when condition that names issues: are those issues closed? An indirect fact, not a check of the condition.
  const conditions = doneWhen(milestone.description);
  const state = new Map(issues.map((i) => [i.number, i.state]));
  const naming = conditions.map((c) => issueRefs(c, input.repo)).filter((ns) => ns.length);
  const conditionsClosed = naming.filter((ns) => ns.every((n) => state.get(n) === 'closed')).length;

  let rating: Rating, reason: string, decides: string[];
  if (!open.length && work.length) { rating = 'done'; reason = `All ${work.length} issues are closed.`; decides = ['closedShare']; }
  else if (!closed.length && !reviewed.length) { rating = 'not started'; reason = work.length ? 'No issue is closed and no pull request is open.' : 'The milestone has no issues.'; decides = ['closedShare', 'inReview']; }
  else if (outside.length) { rating = 'blocked'; reason = `#${outside[0]!.number} waits on #${outside[0]!.blockedBy.find((b) => !b.inMilestone)!.number}, which is outside the milestone.`; decides = ['blockedOutside']; }
  else if (!free.length) { rating = 'blocked'; reason = `Every open issue waits on another one: ${blocked.map((o) => `#${o.number}`).join(', ')}.`; decides = ['blocked']; }
  else if (last !== null && last >= stalledAfter && !reviewed.length) { rating = 'stalled'; reason = `No issue closed in ${last} days and no pull request is open.`; decides = ['daysSinceLastClose', 'inReview']; }
  else if (share >= SELECTIVE_AT && added7 !== null && added7 > closed7) { rating = 'growing'; reason = `${share}% of the issues are closed, and in the last 7 days ${plural(added7, 'issue')} joined while ${closed7} closed.`; decides = ['closedShare', 'addedLast7Days', 'closedLast7Days']; }
  else { rating = 'moving'; reason = last === null ? 'A pull request is open.' : `Last issue closed ${ago(last)}.`; decides = last === null ? ['inReview'] : last >= stalledAfter ? ['daysSinceLastClose', 'inReview'] : ['daysSinceLastClose']; }

  const noTimeline = 'Not measured: the issue timelines were not read.';
  const signals: Signal[] = ([
    ['closedShare', share, `${closed.length} of ${plural(work.length, 'issue')} closed (${share}%).`],
    ['closedLast7Days', closed7, `${plural(closed7, 'issue')} closed in the last 7 days.`],
    ['daysSinceLastClose', last, last === null ? 'No issue is closed yet.' : `The last issue closed ${ago(last)}.`],
    ['inReview', reviewed.length, `${plural(reviewed.length, 'open issue')} ${reviewed.length === 1 ? 'has' : 'have'} an open pull request that closes ${reviewed.length === 1 ? 'it' : 'them'}.`],
    ['oldestReviewDays', reviewAge, reviewAge === null ? 'No such pull request to age.' : `The oldest of those pull requests opened ${ago(reviewAge)}.`],
    ['blocked', blocked.length, `${blocked.length} of ${plural(open.length, 'open issue')} ${blocked.length === 1 ? 'waits' : 'wait'} on an open blocker.`],
    ['blockedOutside', outside.length, `${plural(outside.length, 'open issue')} ${outside.length === 1 ? 'waits' : 'wait'} on a blocker outside the milestone.`],
    ['oldestBlockerDays', blockerAge, blockerAge === null ? 'No open blocker to age.' : `The oldest open blocker was filed ${ago(blockerAge)}.`],
    ['addedAfterStart', added, added === null ? noTimeline : start ? `${plural(added, 'issue')} joined after the first close.` : 'No issue is closed yet, so no issue counts as added.'],
    ['addedLast7Days', added7, added7 === null ? noTimeline : `${added7} of them joined in the last 7 days.`],
    ['reopened', reopened, reopened === null ? noTimeline : `${plural(reopened, 'issue was', 'issues were')} reopened at least once.`],
    ['conditionsClosed', naming.length ? conditionsClosed : null, naming.length ? `${conditionsClosed} of the ${plural(naming.length, 'done-when condition')} that name an issue have every named issue closed.` : 'No done-when condition names an issue.'],
  ] as [string, number | null, string][]).map(([name, value, text]) => ({ name, value, text, decides: decides.includes(name) }));

  return {
    milestone: { title: milestone.title, number: milestone.number, state: milestone.state, current: [...input.openMilestones].sort(byVersion)[0] === milestone.title },
    tracking,
    trackingFrom: fromLine ? 'description' : tracking ? 'sub-issues' : null,
    counts: {
      total: work.length, closed: closed.length, open: open.length,
      inReview: reviewed.length, blocked: blocked.length, blockedOutside: outside.length,
      closedLast7Days: closed7,
    },
    rating, reason, signals, daysSinceLastClose: last, doneWhen: conditions, open, closed,
  };
}
