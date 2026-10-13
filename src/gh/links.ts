// What a pull request will close when it merges, and what it only mentions.
// GitHub closes an issue when a closing keyword sits directly before the reference in the
// PR description or in a commit message that lands on the default branch.

const KEYWORD = '(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)';
const REF = '(?:(?:[\\w.-]+\\/[\\w.-]+)?#\\d+|https:\\/\\/github\\.com\\/[\\w.-]+\\/[\\w.-]+\\/(?:issues|pull)\\/\\d+)';
const CLOSING_RE = new RegExp(`\\b(${KEYWORD})(\\s*:)?\\s+(${REF})`, 'gi');
const REF_RE = new RegExp(`(?<![\\w/&])(${REF})`, 'gi');
const LIST_TAIL_RE = new RegExp(`^(?:\\s*(?:,|and|&)\\s*(${REF}))+`, 'i');
const NEGATION_RE = /\b(?:not|n't|never|no longer|without|partial(?:ly)?|part of|half|maybe|might|may|should|would|could|todo|wip|doesn't|won't|cannot|can't)\b[^.#\n]{0,40}$/i;

export interface Ref { repo: string; number: number }
export interface Hit extends Ref { source: string; line: number; text: string }
export interface ClosingHit extends Hit { keyword: string }
export interface Notice { code: string; msg: string; repo?: string; number?: number; source?: string; line?: number }
export interface Source { source: string; line?: number; text?: string }
export interface Closure extends Ref { sources: Source[]; title?: string; state?: string; kind?: 'issue' | 'pr' }
export interface Mention extends Hit { title?: string; state?: string; kind?: 'issue' | 'pr' }
export interface Commit { sha: string; message: string }
export interface Parsed { closing: ClosingHit[]; mentions: Hit[]; warnings: Notice[] }
export interface LinkReport { willClose: Closure[]; mentions: Mention[]; warnings: Notice[]; errors: Notice[] }

export function normalizeRef(raw: string, repo = ''): Ref {
  const url = raw.match(/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/i);
  if (url) return { repo: url[1]!.toLowerCase(), number: Number(url[2]) };
  const m = raw.match(/^([\w.-]+\/[\w.-]+)?#(\d+)$/);
  return { repo: (m?.[1] ?? repo).toLowerCase(), number: Number(m?.[2]) };
}

export const refKey = (r: Ref): string => `${r.repo}#${r.number}`;

function stripCode(text: string): string {
  const blank = (s: string): string => s.replace(/[^\n]/g, ' ');
  return text
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank);
}

export function parseRefs(text: string, { repo = '', source = 'body' }: { repo?: string; source?: string } = {}): Parsed {
  const clean = stripCode(text);
  const rawLines = text.split('\n');
  const lineOf = (i: number): number => clean.slice(0, i).split('\n').length;
  const lineText = (i: number): string => (rawLines[lineOf(i) - 1] ?? '').trim();
  const closing: ClosingHit[] = [];
  const warnings: Notice[] = [];
  const taken = new Set<number>();

  for (const m of clean.matchAll(CLOSING_RE)) {
    const keyword = m[1]!, raw = m[3]!;
    const ref = normalizeRef(raw, repo);
    taken.add(m.index + m[0].length - raw.length);
    const hit: ClosingHit = { ...ref, keyword, source, line: lineOf(m.index), text: lineText(m.index) };
    closing.push(hit);
    if (NEGATION_RE.test(clean.slice(Math.max(0, m.index - 60), m.index))) {
      warnings.push({ ...ref, source, line: hit.line, code: 'negated-keyword',
        msg: `"${hit.text}" reads as not closing ${raw}, but GitHub ignores the words around a keyword and will close it.` });
    }
    const tail = clean.slice(m.index + m[0].length).match(LIST_TAIL_RE);
    for (const t of tail ? tail[0].matchAll(new RegExp(REF, 'gi')) : []) {
      warnings.push({ ...normalizeRef(t[0], repo), source, line: hit.line, code: 'list-without-keyword',
        msg: `"${keyword} ${raw}, ${t[0]}": only ${raw} closes. Repeat the keyword for ${t[0]} if it should close.` });
    }
  }

  const mentions: Hit[] = [];
  for (const m of clean.matchAll(REF_RE)) {
    if (taken.has(m.index)) continue;
    mentions.push({ ...normalizeRef(m[1]!, repo), source, line: lineOf(m.index), text: lineText(m.index) });
  }
  return { closing, mentions, warnings };
}

export interface LinkInput {
  body?: string;
  commits?: Commit[];
  repo?: string;
  /** Issue numbers the user agreed this PR closes. Empty array means "none". Omit to skip the check. */
  intended?: number[];
  base?: string;
  defaultBranch?: string;
  /** What GitHub itself lists as closing with the PR. */
  github?: Ref[];
}

export function analyzeLinks({ body = '', commits = [], repo = '', intended, base, defaultBranch, github }: LinkInput): LinkReport {
  const here = repo.toLowerCase();
  const parts = [parseRefs(body, { repo, source: 'body' }),
    ...commits.map((c) => parseRefs(c.message, { repo, source: `commit ${c.sha.slice(0, 7)}` }))];
  const closing = parts.flatMap((p) => p.closing);
  const warnings = parts.flatMap((p) => p.warnings);
  const errors: Notice[] = [];

  const byKey = new Map<string, Closure>();
  for (const c of closing) {
    const cur = byKey.get(refKey(c)) ?? { repo: c.repo, number: c.number, sources: [] };
    cur.sources.push({ source: c.source, line: c.line, text: c.text });
    byKey.set(refKey(c), cur);
  }
  const mentions = dedupe(parts.flatMap((p) => p.mentions).filter((m) => !byKey.has(refKey(m))));

  for (const c of byKey.values()) {
    if (c.sources.every((s) => s.source.startsWith('commit'))) {
      warnings.push({ repo: c.repo, number: c.number, code: 'commit-only',
        msg: `#${c.number} closes through a commit message only (${c.sources.map((s) => s.source).join(', ')}). The PR body does not show it. It closes when that commit lands on the default branch.` });
    }
  }

  if (base && defaultBranch && base !== defaultBranch && byKey.size) {
    warnings.push({ code: 'non-default-base',
      msg: `Base branch is "${base}", not the default "${defaultBranch}". Closing keywords do nothing until the commits reach "${defaultBranch}".` });
  }

  if (github) {
    const listed = new Set(github.map(refKey));
    for (const c of [...byKey.values()]) {
      if (!listed.has(refKey(c)) && c.repo === here && c.sources.some((s) => s.source === 'body')) {
        warnings.push({ repo: c.repo, number: c.number, code: 'not-linked-on-github',
          msg: `The body has a closing keyword for #${c.number}, and GitHub does not list it as linked. Check that #${c.number} is an open issue in this repository.` });
      }
    }
    for (const g of github) {
      if (byKey.has(refKey(g))) continue;
      warnings.push({ ...g, code: 'linked-in-sidebar',
        msg: `GitHub lists #${g.number} as closing with this PR, and no keyword in the body or commits names it. It was linked by hand in the Development sidebar.` });
      byKey.set(refKey(g), { ...g, sources: [{ source: 'github link' }] });
    }
  }

  if (intended) {
    const want = new Set(intended.map((n) => refKey({ repo: here, number: n })));
    for (const c of byKey.values()) {
      if (want.has(refKey(c))) continue;
      const src = c.sources[0]!;
      errors.push({ repo: c.repo, number: c.number, code: 'unintended-close',
        msg: `#${c.number} will close on merge and is not in the intended list. Source: ${src.source}${src.line ? ` line ${src.line}` : ''}${src.text ? `: "${src.text}"` : ''}. To keep the reference without closing, write "Refs #${c.number}".` });
    }
    for (const n of intended) {
      if (byKey.has(refKey({ repo: here, number: n }))) continue;
      errors.push({ number: n, code: 'missing-close',
        msg: `#${n} should close with this PR and no closing keyword names it. Add a line "Closes #${n}" to the PR body.` });
    }
  }

  return { willClose: [...byKey.values()], mentions, warnings, errors };
}

function dedupe(list: Hit[]): Mention[] {
  const seen = new Map<string, Mention>();
  for (const m of list) if (!seen.has(refKey(m))) seen.set(refKey(m), { ...m });
  return [...seen.values()];
}
