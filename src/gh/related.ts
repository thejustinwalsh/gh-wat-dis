// Find issues and pull requests that may cover the same ground as a draft or an existing issue.
// Reports signals, each with a label. It never decides that two issues are duplicates.

import { errorMessage } from '../cli/util.ts';
import type { Provenance } from '../spec.ts';

const STOP = new Set(`a an and are as at be been but by can could did do does for from had has have how i if in into is it its
of on or our should so than that the their then there these this those to too was we were what when where which while who why will
with would you your not no yes add added adding fix fixed fixes bug issue error fails failing failed broken support make use using
new update updated change changed need needs want wants after before during also get gets set sets`.split(/\s+/));

const PATH_RE = /(?<![\w/.-])((?:[\w@.-]+\/)+[\w.-]+\.[A-Za-z]{1,6})(?::\d+)?/g;
const SPAN_RE = /`([^`\n]{4,120})`/g;
const IDENT_RE = /\b([A-Za-z_][A-Za-z0-9_]*(?:(?:::|\.)[A-Za-z_][A-Za-z0-9_]*)+|[a-z]+(?:[A-Z][a-z0-9]+)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+|[a-z0-9]+(?:_[a-z0-9]+)+)\b/g;
const ERROR_RE = /\b(?:[A-Za-z]*(?:Error|Exception)|panic(?:ked)?|failed to|cannot|could not|unexpected|error\[E\d{4}\]|TS\d{4,5})\b[^\n`]*/g;
const CODE_LIKE = /[._:/()#<>=-]|[a-z][A-Z]|\d/;
const COMMON = new Set(`github gitlab javascript typescript postgresql mysql sqlite mongodb graphql webassembly oauth openai
nodejs node.js next.js vue.js react.js macos ios iphone youtube linkedin wordpress devops`.split(/\s+/));
const FENCE_RE = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm;

export interface Draft { title?: string; body?: string; paths?: string[] }
export interface Signals { terms: string[]; bodyTerms: string[]; paths: string[]; spans: string[]; idents: string[]; errors: string[] }
export interface Query { why: string; query: string }
export interface Signal { label: Provenance; kind: string; detail: string }

/** One search hit, as the caller's search function returns it. */
export interface Row {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  stateReason?: string | null;
  url?: string;
  updatedAt?: string;
  labels?: (string | { name: string })[];
  milestone?: { title: string } | null;
  isPullRequest?: boolean;
}

export interface Candidate {
  number: number;
  kind: 'issue' | 'pr';
  title: string;
  state: string;
  stateReason: string | null;
  url?: string;
  updatedAt?: string;
  labels: string[];
  milestone: string | null;
  points: number;
  signals: Signal[];
  matchedQueries: string[];
}

export interface RelatedResult {
  signals: Signals;
  queries: Query[];
  failed: (Query & { error: string })[];
  /** False when a query failed: the candidate list may miss issues. */
  complete: boolean;
  candidates: Candidate[];
}

const uniq = <T>(a: T[]): T[] => [...new Set(a)];

export function tokens(text = ''): string[] {
  return uniq(text.toLowerCase().replace(/`[^`]*`/g, ' ').split(/[^a-z0-9_]+/)
    .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)));
}

export function extractSignals({ title = '', body = '', paths = [] }: Draft): Signals {
  const text = `${title}\n${body}`;
  const noFence = text.replace(FENCE_RE, (b) => b.split('\n').slice(1, -1).join('\n'));
  const filePaths = uniq([...paths, ...[...noFence.matchAll(PATH_RE)].map((m) => m[1]!)]).filter((p) => !/^https?:/.test(p));
  // A span or a word counts as an identifier only when it looks like code. Product names and
  // plain words in backticks ("GitHub", `diagram`) would match half the tracker.
  const spans = uniq([...text.matchAll(SPAN_RE)].map((m) => m[1]!.trim()))
    .filter((s) => !filePaths.includes(s.replace(/:\d+$/, '')) && CODE_LIKE.test(s) && !COMMON.has(s.toLowerCase()));
  const idents = uniq([...noFence.replace(PATH_RE, ' ').matchAll(IDENT_RE)].map((m) => m[1]!))
    .filter((s) => s.length > 5 && !COMMON.has(s.toLowerCase()) && (/[._:]/.test(s) || /^[a-z]/.test(s) || (s.match(/[A-Z]/g) ?? []).length >= 3));
  const errors = uniq([...noFence.matchAll(ERROR_RE)].map((m) => m[0].trim().replace(/[.,;:]+$/, '').slice(0, 100)))
    .filter((e) => e.split(/\s+/).length >= 3).slice(0, 3);
  return { terms: tokens(title), bodyTerms: tokens(body), paths: filePaths, spans, idents, errors };
}

const quote = (s: string): string => `"${s.replace(/["\\]/g, ' ').trim()}"`;

export function buildQueries(sig: Signals, { max = 6 }: { max?: number } = {}): Query[] {
  // Exact signals first: GitHub limits searches, and these find duplicates that shared words miss.
  const q: Query[] = [];
  const t = sig.terms;
  for (const e of sig.errors.slice(0, 1)) q.push({ why: 'error text', query: quote(e.split(/\s+/).slice(0, 8).join(' ')) });
  for (const p of sig.paths.slice(0, 2)) q.push({ why: 'file path', query: quote(p) });
  for (const s of [...sig.idents, ...sig.spans.filter((x) => !/\s/.test(x))].slice(0, 2)) q.push({ why: 'identifier', query: quote(s) });
  if (t.length) q.push({ why: 'title terms', query: `${t.slice(0, 4).join(' ')} in:title` });
  if (t.length > 2) q.push({ why: 'title terms, any field', query: t.slice(0, 3).join(' ') });
  if (t.length > 4) q.push({ why: 'title terms', query: `${t.slice(2, 5).join(' ')} in:title` });
  const seen = new Set<string>();
  return q.filter((x) => !seen.has(x.query) && seen.add(x.query)).slice(0, max);
}

/** Exact matches (error text, identifiers, paths) outweigh shared words by design. */
export function score(sig: Signals, cand: Pick<Row, 'title' | 'body'>): { points: number; signals: Signal[] } {
  const text = `${cand.title}\n${cand.body ?? ''}`;
  const lower = text.toLowerCase();
  const signals: Signal[] = [];
  let points = 0;

  const ct = new Set(tokens(cand.title));
  const shared = sig.terms.filter((w) => ct.has(w));
  if (shared.length) {
    points += Math.round((shared.length / (new Set([...sig.terms, ...ct]).size || 1)) * 30);
    signals.push({ label: 'heuristic', kind: 'title-terms', detail: `shares ${shared.length} of ${sig.terms.length} title terms: ${shared.slice(0, 6).join(', ')}` });
  }
  const errs = sig.errors.filter((e) => lower.includes(e.toLowerCase().slice(0, 60)));
  if (errs.length) { points += 40; signals.push({ label: 'exact', kind: 'error-text', detail: `same error text: "${errs[0]}"` }); }

  const ids = uniq([...sig.idents, ...sig.spans]).filter((s) => text.includes(s));
  if (ids.length) {
    points += Math.min(40, ids.length * 20);
    signals.push({ label: 'exact', kind: 'identifier', detail: `names the same identifiers: ${ids.slice(0, 4).map((s) => `\`${s}\``).join(', ')}` });
  }
  const paths = sig.paths.filter((p) => text.includes(p));
  if (paths.length) {
    points += Math.min(40, paths.length * 20);
    signals.push({ label: 'exact', kind: 'file-path', detail: `names the same files: ${paths.slice(0, 3).join(', ')}` });
  }
  const bodyShared = sig.bodyTerms.filter((w) => !sig.terms.includes(w) && lower.includes(w));
  if (sig.bodyTerms.length >= 8 && bodyShared.length / sig.bodyTerms.length > 0.5) {
    points += 10;
    signals.push({ label: 'heuristic', kind: 'body-terms', detail: `shares ${bodyShared.length} of ${sig.bodyTerms.length} body terms` });
  }
  return { points: Math.min(100, points), signals };
}

export interface RelatedInput extends Draft {
  /** The issue being checked, so it is not reported as related to itself. */
  self?: number;
  limit?: number;
  search: (query: string) => Promise<Row[]>;
  /** Base wait before a retry after a rate-limit error. */
  retryMs?: number;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function findRelated({ title, body, paths, self, limit = 10, search, retryMs = 20000 }: RelatedInput): Promise<RelatedResult> {
  const sig = extractSignals({ title, body, paths });
  const queries = buildQueries(sig);
  const pool = new Map<number, Row & { matched: string[] }>();
  const failed: RelatedResult['failed'] = [];
  for (const q of queries) {
    let rows: Row[] | undefined;
    let error = '';
    // GitHub allows about 30 searches a minute. Wait and try again before giving up on a query.
    for (let attempt = 0; attempt < 3 && !rows; attempt++) {
      try { rows = await search(q.query); }
      catch (e) {
        error = errorMessage(e);
        if (!/rate limit|secondary|403|429/i.test(error) || attempt === 2) break;
        await wait(retryMs * (attempt + 1));
      }
    }
    if (!rows) { failed.push({ ...q, error: error.split('\n').find((l) => /rate limit|HTTP|gh:/i.test(l)) ?? error.split('\n')[0]! }); continue; }
    for (const r of rows) {
      if (r.number === self) continue;
      const cur = pool.get(r.number) ?? { ...r, matched: [] };
      cur.matched.push(q.why);
      pool.set(r.number, cur);
    }
  }
  const candidates = [...pool.values()].map((c): Candidate => {
    const s = score(sig, c);
    return {
      number: c.number, kind: c.isPullRequest ? 'pr' : 'issue', title: c.title, state: c.state,
      stateReason: c.stateReason ?? null, url: c.url, updatedAt: c.updatedAt,
      labels: (c.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)), milestone: c.milestone?.title ?? null,
      points: s.points, signals: s.signals, matchedQueries: uniq(c.matched),
    };
  }).filter((c) => c.signals.length).sort((a, b) => b.points - a.points || b.number - a.number).slice(0, limit);
  return { signals: sig, queries, failed, complete: failed.length === 0, candidates };
}

/** What the Points column measures. Printed with every table, so the number is never a bare score. */
export const POINTS_KEY = 'Points, 0 to 100, add up what a candidate shares with the draft: 40 for the same error text, 20 for each shared identifier and each shared file path (40 at most for each kind), up to 30 for shared title words, 10 for shared body words. Exact matches are labeled `exact` and shared words `heuristic`. 30 or more means at least one exact match or a near-identical title: read those.';

export function toMarkdown(res: RelatedResult): string {
  const gap = res.failed.length
    ? `\n**Incomplete:** ${res.failed.length} of ${res.queries.length} searches failed (${res.failed[0]!.error.slice(0, 80)}). Run it again before you rely on this list.\n`
    : '';
  if (!res.candidates.length) {
    return res.failed.length === res.queries.length && res.queries.length
      ? `Could not search: all ${res.queries.length} searches failed (${res.failed[0]!.error.slice(0, 80)}). This is not a "no match" result.\n`
      : `No related issues or pull requests found. Queries run: ${res.queries.length}.\n${gap}`;
  }
  const rows = res.candidates.map((c) => {
    const state = c.stateReason ? `${c.state} (${c.stateReason})` : c.state;
    const why = c.signals.map((s) => `${s.detail} [${s.label}]`).join('; ');
    return `| #${c.number} | ${c.kind} | ${state.toLowerCase()} | ${c.points} | ${c.title.replace(/\|/g, '\\|').slice(0, 70)} | ${why} |`;
  });
  return [
    `**${res.candidates.length} related** from ${res.queries.length} queries. Signals only: read each one before you call it a duplicate.`,
    '',
    POINTS_KEY,
    '',
    '| # | Kind | State | Points | Title | Shared with the draft |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n') + gap;
}
