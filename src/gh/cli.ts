import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import type { Config } from '../cli/config.ts';
import { CONFIG_REL, UsageError, parseArgs, readInput, readJson, repoRoot, run } from '../cli/util.ts';
import { planLabels } from './labels.ts';
import type { LiveLabel } from './labels.ts';
import { byVersion, milestoneStatus } from './milestone.ts';
import type { RawIssue } from './milestone.ts';
import { readRelations, relate } from './relations.ts';
import type { Api } from './relations.ts';
import { analyzeLinks } from './links.ts';
import type { Closure, Commit, Mention, Ref } from './links.ts';
import { findRelated, toMarkdown } from './related.ts';
import type { Row } from './related.ts';

const exec = promisify(execFile);

async function gh<T>(args: string[]): Promise<T> {
  const { stdout } = await exec('gh', args, { maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout) as T;
}

function repoInfo(): { repo: string; defaultBranch?: string } {
  const out = run('gh', ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef']);
  if (!out) throw new Error('no GitHub repository found for this directory. Run inside a clone with a GitHub remote, signed in with gh.');
  const j = JSON.parse(out) as { nameWithOwner: string; defaultBranchRef?: { name?: string } };
  return { repo: j.nameWithOwner, defaultBranch: j.defaultBranchRef?.name };
}

interface SearchItem {
  number: number; title: string; body: string | null; state: string; state_reason: string | null;
  html_url: string; updated_at: string; labels: { name: string }[]; milestone: { title: string } | null; pull_request?: unknown;
}

const RELATED_USAGE = 'Usage: npx gh-wat-dis related (--issue <n> | --title "<text>" [--body-file <file>]) [--paths a,b] [--state all|open|closed] [--limit 10] [--md]';

export async function related(argv: string[]): Promise<number> {
  const args = parseArgs(argv, {
    booleans: ['md', 'json', 'help'], strings: ['issue', 'title', 'body-file', 'paths', 'limit', 'state'],
    aliases: { '-i': '--issue', '-t': '--title', '-b': '--body-file', '-n': '--limit', '-h': '--help' },
  });
  if (args.help) { console.log(RELATED_USAGE); return 0; }
  let title = args.title;
  let body = args['body-file'] ? readInput(args['body-file']) : '';
  let self: number | undefined;
  if (args.issue) {
    const j = await gh<{ number: number; title: string; body: string }>(['issue', 'view', args.issue, '--json', 'number,title,body']);
    ({ title, body } = j);
    self = j.number;
  }
  title ||= body.split('\n').find((l) => l.trim() && !/^[#>!<|`-]/.test(l.trim()));
  if (!title) throw new UsageError(RELATED_USAGE);

  const { repo } = repoInfo();
  const state = args.state ?? 'all';
  const stateQ = state === 'all' ? '' : ` is:${state}`;
  const search = async (query: string): Promise<Row[]> => {
    const res = await gh<{ items: SearchItem[] }>(['api', '-X', 'GET', 'search/issues', '-f', `q=${query} repo:${repo}${stateQ}`, '-f', 'per_page=15']);
    return res.items.map((i) => ({
      number: i.number, title: i.title, body: i.body, state: i.state.toUpperCase(), stateReason: i.state_reason,
      url: i.html_url, updatedAt: i.updated_at, labels: i.labels, milestone: i.milestone, isPullRequest: Boolean(i.pull_request),
    }));
  };
  const res = await findRelated({
    title, body, self, search, limit: Number(args.limit ?? 10),
    paths: args.paths ? args.paths.split(',').map((s) => s.trim()).filter(Boolean) : [],
  });
  for (const f of res.failed) console.error(`search failed (${f.why}): ${f.error}`);
  process.stdout.write(args.md ? toMarkdown(res) : JSON.stringify(res, null, 2) + '\n');
  // A search that could not run is not a clean result.
  return res.queries.length && res.failed.length === res.queries.length ? 1 : 0;
}

interface PrView {
  body: string | null;
  baseRefName: string;
  commits: { oid: string; messageHeadline: string; messageBody?: string }[];
  closingIssuesReferences: { number: number; repository?: { name: string; owner: { login: string } } }[];
}

const LINKS_USAGE = 'Usage: npx gh-wat-dis links (--pr <n> | --body-file <file>) [--base <branch>] [--closes 12,15 | --closes none] [--no-commits] [--text]';

export async function links(argv: string[]): Promise<number> {
  const args = parseArgs(argv, {
    booleans: ['text', 'json', 'no-commits', 'help'], strings: ['pr', 'body-file', 'base', 'closes'],
    aliases: { '-b': '--body-file', '-h': '--help' },
  });
  if (args.help) { console.log(LINKS_USAGE); return 0; }
  if (!args.pr && !args['body-file']) throw new UsageError(LINKS_USAGE);

  const { repo, defaultBranch } = repoInfo();
  const here = repo.toLowerCase();
  let body = args['body-file'] ? readInput(args['body-file']) : '';
  let commits: Commit[] = [];
  let base = args.base;
  let github: Ref[] | undefined;

  if (args.pr) {
    const j = await gh<PrView>(['pr', 'view', args.pr, '--json', 'body,baseRefName,commits,closingIssuesReferences']);
    if (!args['body-file']) body = j.body ?? '';
    base ??= j.baseRefName;
    commits = j.commits.map((c) => ({ sha: c.oid, message: `${c.messageHeadline}\n\n${c.messageBody ?? ''}` }));
    github = j.closingIssuesReferences.map((r) => ({
      repo: (r.repository ? `${r.repository.owner.login}/${r.repository.name}` : repo).toLowerCase(), number: r.number,
    }));
  } else {
    base ??= defaultBranch;
    const from = base ? (run('git', ['merge-base', 'HEAD', `origin/${base}`]) ?? run('git', ['merge-base', 'HEAD', base])) : null;
    const log = from ? run('git', ['log', '--format=%H%x1f%B%x1e', `${from}..HEAD`]) : null;
    commits = (log ?? '').split('\x1e').map((s) => s.trim()).filter(Boolean).map((s) => {
      const [sha = '', message = ''] = s.split('\x1f');
      return { sha, message };
    });
  }
  if (args['no-commits']) commits = [];

  const intended = args.closes === undefined ? undefined
    : args.closes === 'none' ? []
    : args.closes.split(',').map((s) => Number(s.replace(/^#/, '').trim())).filter(Boolean);

  const res = analyzeLinks({ body, commits, repo, intended, base, defaultBranch, github });

  const refs: (Closure | Mention)[] = [...res.willClose, ...res.mentions];
  const local = [...new Set(refs.filter((r) => r.repo === here).map((r) => r.number))].slice(0, 30);
  const info = new Map<number, { title: string; state: string; kind: 'issue' | 'pr' } | null>();
  await Promise.all(local.map(async (n) => {
    try {
      const j = await gh<{ title: string; state: string; pull_request?: unknown }>(['api', `repos/${repo}/issues/${n}`]);
      info.set(n, { title: j.title, state: j.state, kind: j.pull_request ? 'pr' : 'issue' });
    } catch { info.set(n, null); }
  }));
  for (const r of refs) {
    if (r.repo !== here || !info.has(r.number)) continue;
    const t = info.get(r.number);
    if (t) Object.assign(r, t);
    else res.warnings.push({ number: r.number, code: 'not-found', msg: `#${r.number} does not exist in ${repo}.` });
  }
  for (const c of res.willClose) {
    if (c.kind === 'pr') res.warnings.push({ number: c.number, code: 'closes-a-pr', msg: `#${c.number} is a pull request, not an issue. A closing keyword does not close it.` });
    if (c.state === 'closed') res.warnings.push({ number: c.number, code: 'already-closed', msg: `#${c.number} is already closed.` });
  }

  const code = res.errors.length ? 1 : 0;
  if (!args.text) {
    console.log(JSON.stringify(res, null, 2));
    return code;
  }
  const name = (r: Closure | Mention): string =>
    `${r.repo === here ? '' : r.repo}#${r.number}${r.title ? `  ${r.title}` : ''}${r.state ? ` (${r.state})` : ''}`;
  console.log(`Will close on merge${base ? ` into ${base}` : ''}: ${res.willClose.length || 'none'}`);
  for (const c of res.willClose) {
    console.log(`  ${name(c)}`);
    for (const s of c.sources) console.log(`      from ${s.source}${s.line ? `:${s.line}` : ''}${s.text ? `  "${s.text}"` : ''}`);
  }
  console.log(`Mentioned, stays open: ${res.mentions.length || 'none'}`);
  for (const m of res.mentions) console.log(`  ${name(m)}`);
  for (const w of res.warnings) console.log(`warn   ${w.msg}`);
  for (const e of res.errors) console.log(`error  ${e.msg}`);
  if (intended === undefined && res.willClose.length) {
    console.log(`\nConfirm the list with the user, then check it: --closes ${res.willClose.map((c) => c.number).join(',')}`);
  }
  return code;
}

function loadConfig(): Config {
  const cfg = readJson<Config>(join(repoRoot(), CONFIG_REL));
  if (!cfg) throw new UsageError(`no ${CONFIG_REL} here. Create it: npx gh-wat-dis init`);
  return cfg;
}

const LABELS_USAGE = `Usage: npx gh-wat-dis labels [--text]                 compare the labels the config wants with GitHub
       npx gh-wat-dis labels apply [--prune] [--dry-run]  create and update them. --prune also deletes the rest.
Labels mean two things: "agents", and the product surface an issue touches (labels.surfaces in the config,
or one for each mapped architecture element when that list is empty). A repository under a user account
has no GitHub issue types, so there the types (task, bug, feature) are labels too.`;

export async function labels(argv: string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['text', 'prune', 'dry-run', 'help'], aliases: { '-h': '--help', '-n': '--dry-run' } });
  if (args.help) { console.log(LABELS_USAGE); return 0; }
  const apply = args._[0] === 'apply';
  if (args._[0] && args._[0] !== 'plan' && !apply) throw new UsageError(LABELS_USAGE);
  const live = await gh<LiveLabel[]>(['label', 'list', '--limit', '300', '--json', 'name,description,color']);
  const plan = planLabels(loadConfig(), live);
  if (!apply) {
    if (!args.text) { console.log(JSON.stringify(plan, null, 2)); return 0; }
    console.log(`Surface labels come from: ${plan.surfacesFrom === 'config' ? 'labels.surfaces in the config' : plan.surfacesFrom === 'architecture' ? 'the architecture map (labels.surfaces is empty)' : 'nowhere yet. Map the architecture or fill labels.surfaces.'}`);
    for (const l of plan.create) console.log(`create  ${l.name.padEnd(16)} ${l.description}`);
    for (const l of plan.update) console.log(`update  ${l.name.padEnd(16)} ${l.description}`);
    for (const n of plan.keep) console.log(`keep    ${n}`);
    for (const l of plan.extra) console.log(`extra   ${l.name.padEnd(16)} not in the plan. "labels apply --prune" deletes it from every issue.`);
    return 0;
  }
  const act = async (verb: string, l: { name: string }, cmd: string[]): Promise<boolean> => {
    console.log(`${verb.padEnd(7)} ${l.name}`);
    if (args['dry-run']) return true;
    try { await exec('gh', cmd); return true; } catch (e) { console.error(`  failed: ${(e instanceof Error ? e.message : String(e)).split('\n')[1] ?? e}`); return false; }
  };
  let ok = true;
  for (const l of plan.create) ok = await act('create', l, ['label', 'create', l.name, '--color', l.color, '--description', l.description]) && ok;
  for (const l of plan.update) ok = await act('update', l, ['label', 'edit', l.name, '--color', l.color, '--description', l.description]) && ok;
  if (args.prune) for (const l of plan.extra) ok = await act('delete', l, ['label', 'delete', l.name, '--yes']) && ok;
  else if (plan.extra.length) console.log(`${plan.extra.length} other labels left in place: ${plan.extra.map((l) => l.name).join(', ')}`);
  if (args['dry-run']) console.log('Dry run. Nothing changed.');
  return ok ? 0 : 1;
}

const RELATIONS_USAGE = `Usage: npx gh-wat-dis relations <issue>                                   parent, sub-issues, blocked by, blocking (JSON)
       npx gh-wat-dis relate <issue> [--parent <n>] [--blocked-by <n,n>] [--blocks <n,n>] [--remove]
These are GitHub's own relations. They show in the issue sidebar and in filters such as is:blocked.`;

const api: Api = async <T>(args: string[]): Promise<T> => {
  const { stdout } = await exec('gh', ['api', ...args], { maxBuffer: 32 * 1024 * 1024 });
  return (stdout.trim() ? JSON.parse(stdout) : null) as T;
};
const issueNumber = (s: string | undefined): number => {
  const n = Number((s ?? '').replace(/^#/, ''));
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(RELATIONS_USAGE);
  return n;
};
const numbers = (s: string | undefined): number[] => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean).map(issueNumber);

export async function relations(argv: string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['help'], aliases: { '-h': '--help' } });
  if (args.help) { console.log(RELATIONS_USAGE); return 0; }
  console.log(JSON.stringify(await readRelations(api, repoInfo().repo, issueNumber(args._[0])), null, 2));
  return 0;
}

export async function relateCmd(argv: string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['remove', 'help'], strings: ['parent', 'blocked-by', 'blocks'], aliases: { '-h': '--help' } });
  if (args.help) { console.log(RELATIONS_USAGE); return 0; }
  const n = issueNumber(args._[0]);
  if (!args.parent && !args['blocked-by'] && !args.blocks) throw new UsageError(RELATIONS_USAGE);
  const results = await relate(api, repoInfo().repo, n, {
    parent: args.parent ? issueNumber(args.parent) : undefined, blockedBy: numbers(args['blocked-by']), blocks: numbers(args.blocks), remove: args.remove,
  });
  for (const r of results) console.log(`${r.ok ? 'ok    ' : 'FAIL  '} ${r.action}${r.detail ? `  (${r.detail})` : ''}`);
  return results.every((r) => r.ok) ? 0 : 1;
}

const MILESTONE_USAGE = `Usage: npx gh-wat-dis milestone [<title>] [--stalled-after 7]
Prints the numbers for a status report as JSON: issue counts (pull requests and the tracking issue are not counted),
what is in review, what is blocked and by what, the done-when conditions, and a status: done, blocked, stalled or moving.
With no title it reports the current milestone: the lowest open version. Milestones have no due dates.`;

export async function milestone(argv: string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['help'], strings: ['stalled-after'], aliases: { '-h': '--help' } });
  if (args.help) { console.log(MILESTONE_USAGE); return 0; }
  const { repo } = repoInfo();
  type M = { title: string; number: number; state: string; description: string | null };
  const all = await api<M[]>([`repos/${repo}/milestones?state=all&per_page=100`]);
  const openTitles = all.filter((m) => m.state === 'open').map((m) => m.title);
  const want = args._[0] ?? [...openTitles].sort(byVersion)[0];
  const found = all.find((m) => m.title === want);
  if (!found) throw new UsageError(want ? `no milestone "${want}". Milestones: ${all.map((m) => m.title).join(', ') || 'none'}` : 'this repository has no open milestone');
  const items = await api<RawIssue[]>([`repos/${repo}/issues?milestone=${found.number}&state=all&per_page=100`, '--paginate']);
  const openIssues = items.filter((i) => !i.pull_request && i.state === 'open');
  const blockedBy = new Map<number, { number: number; title: string; state: string }[]>();
  await Promise.all(openIssues.map(async (i) => {
    try { blockedBy.set(i.number, await api([`repos/${repo}/issues/${i.number}/dependencies/blocked_by`])); } catch { blockedBy.set(i.number, []); }
  }));
  const prs = await gh<{ number: number; closingIssuesReferences: { number: number }[] }[]>(['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,closingIssuesReferences']);
  const out = milestoneStatus({
    milestone: found, openMilestones: openTitles, items, blockedBy,
    openPrs: prs.map((p) => ({ number: p.number, closes: p.closingIssuesReferences.map((r) => r.number) })),
    now: new Date(), stalledAfterDays: args['stalled-after'] ? Number(args['stalled-after']) : undefined,
  });
  console.log(JSON.stringify(out, null, 2));
  return 0;
}
