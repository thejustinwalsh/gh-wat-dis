import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DisItem, ItemRef, LinkedItem } from '../dis/types.ts';
import { UsageError } from '../cli/util.ts';
import { apiMessage } from './relations.ts';

const exec = promisify(execFile);
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/;
const SHA = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i;
const REF_USAGE = 'use an issue or PR number, owner/repo#number, or a https://github.com/owner/repo/issues/number or /pull/number URL';
interface ResolvedRef extends ItemRef { expectedKind?: 'issue' | 'pr' }

interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  updated_at: string;
  labels: (string | { name: string })[];
  pull_request?: { merged_at?: string | null };
  sub_issues_summary?: { total: number };
  issue_dependencies_summary?: { total_blocked_by: number };
}
interface RawComment { body: string | null; html_url: string; user: { login: string } | null; created_at?: string }
interface RawPr { base: { sha: string }; head: { sha: string }; merged_at: string | null }
interface NativeLink { number: number; title: string; state: string; url: string; __typename: string; repository: { nameWithOwner: string } }
interface Connection { nodes: NativeLink[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
interface NativePage { data: { repository: Record<string, Record<string, Connection>> | null } }

function validRepo(repo: string): boolean {
  return REPO.test(repo) && !['.', '..'].includes(repo.split('/')[1]!);
}

function numberOf(value: string): number {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1) throw new UsageError(REF_USAGE);
  return number;
}

function urlRef(input: string): ResolvedRef | null {
  let url: URL;
  try { url = new URL(input); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password) return null;
  const match = /^\/([^/]+\/[^/]+)\/(issues|pull)\/(\d+)\/?$/.exec(url.pathname);
  if (!match || !validRepo(match[1]!)) return null;
  const number = numberOf(match[3]!);
  const expectedKind = match[2] === 'pull' ? 'pr' : 'issue';
  return { repo: match[1]!, number, url: `https://github.com/${match[1]}/${match[2]}/${number}`, expectedKind };
}

/** Every value is an argument, never shell text. Thread bodies never enter a command. */
async function gh<T>(args: string[], source: string, cwd: string): Promise<T> {
  try {
    const { stdout } = await exec('gh', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    const result = JSON.parse(stdout) as T & { errors?: { message: string }[] };
    if (result.errors?.length) throw new Error(result.errors.map((e) => e.message).join('; '));
    return result;
  } catch (error) {
    throw new Error(`Could not read ${source}: ${apiMessage(error)}`, { cause: error });
  }
}

async function api<T>(path: string, source: string, cwd: string): Promise<T> {
  return gh<T>(['api', '--hostname', 'github.com', path], source, cwd);
}

async function pages<T>(path: string, source: string, cwd: string): Promise<T[]> {
  const result = await gh<T[][]>(['api', '--hostname', 'github.com', path, '--paginate', '--slurp'], source, cwd);
  return result.flat();
}

function notFound(error: unknown): boolean {
  const cause = (error as Error)?.cause as { stdout?: string; stderr?: string } | undefined;
  try { if (String((JSON.parse(cause?.stdout ?? '') as { status?: string | number }).status) === '404') return true; } catch { /* gh may print no JSON body. */ }
  return /\bHTTP 404\b/.test(cause?.stderr ?? '');
}

async function resolveRef(input: string, cwd: string): Promise<ResolvedRef> {
  const value = input.trim();
  const url = urlRef(value);
  if (url) return url;
  const qualified = /^([^#]+)#(\d+)$/.exec(value);
  if (qualified && validRepo(qualified[1]!)) {
    const repo = qualified[1]!;
    const number = numberOf(qualified[2]!);
    return { repo, number, url: `https://github.com/${repo}/issues/${number}` };
  }
  if (!/^#?\d+$/.test(value)) throw new UsageError(REF_USAGE);
  const number = numberOf(value.replace(/^#/, ''));
  const target = process.env.GH_REPO;
  const source = target && validRepo(target) ? `https://github.com/${target}/issues/${number} (GH_REPO=${target})` : 'the current repository (run inside a clone, or set GH_REPO=owner/repo)';
  const view = await gh<{ nameWithOwner: string }>(['repo', 'view', ...(target ? [target] : []), '--json', 'nameWithOwner'], source, cwd);
  if (!validRepo(view.nameWithOwner)) throw new Error('GitHub returned no owner/repo name for this item.');
  return { repo: view.nameWithOwner, number, url: `https://github.com/${view.nameWithOwner}/issues/${number}` };
}

function linkedIssue(raw: RawIssue): LinkedItem {
  const ref = urlRef(raw.html_url);
  if (!ref) throw new Error(`GitHub returned an unsupported item URL: ${raw.html_url}`);
  return { repo: ref.repo, number: raw.number, url: ref.url, title: raw.title, kind: raw.pull_request || ref.expectedKind === 'pr' ? 'pr' : 'issue', state: raw.pull_request?.merged_at ? 'merged' : raw.state.toLowerCase() };
}

/** GitHub's closing links, including closed PRs, with every connection page. */
async function closingLinks(ref: ItemRef, kind: 'issue' | 'pr', cwd: string): Promise<LinkedItem[]> {
  const [owner, name] = ref.repo.split('/') as [string, string];
  const field = kind === 'issue' ? 'closedByPullRequestsReferences' : 'closingIssuesReferences';
  const item = kind === 'issue' ? 'issue' : 'pullRequest';
  const query = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){${item}(number:$number){${field}(first:100,after:$after${kind === 'issue' ? ',includeClosedPrs:true' : ''}){pageInfo{hasNextPage endCursor} nodes{__typename number title state url repository{nameWithOwner}}}}}}`;
  const links: LinkedItem[] = [];
  for (let after: string | null = null; ;) {
    const result: NativePage = await gh<NativePage>([
      'api', '--hostname', 'github.com', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${ref.number}`, ...(after ? ['-f', `after=${after}`] : []),
    ], ref.url, cwd);
    const connection = result.data.repository?.[item]?.[field];
    if (!connection) throw new Error(`Could not read linked work for ${ref.url}: GitHub returned no ${field}.`);
    links.push(...connection.nodes.map((node): LinkedItem => ({
      repo: node.repository.nameWithOwner, number: node.number, url: node.url, title: node.title, state: node.state.toLowerCase(), kind: node.__typename === 'PullRequest' ? 'pr' : 'issue',
    })));
    if (!connection.pageInfo.hasNextPage) return links;
    const next = connection.pageInfo.endCursor;
    if (!next || next === after) throw new Error(`Could not read every linked-work page for ${ref.url}: GitHub returned no next cursor.`);
    after = next;
  }
}

export type ItemStamp = ItemRef & ({ kind: 'issue'; updatedAt: string } | { kind: 'pr'; updatedAt: string; baseSha: string; headSha: string });

/** Cache probes request identity and drift inputs only, without thread text or links. */
export async function readItemStamp(input: string, opts: { cwd?: string } = {}): Promise<ItemStamp> {
  const cwd = opts.cwd ?? process.cwd();
  const requested = await resolveRef(input, cwd);
  const [owner, name] = requested.repo.split('/') as [string, string];
  const fields = 'number url updatedAt repository{nameWithOwner}';
  const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){__typename ... on Issue{${fields}} ... on PullRequest{${fields} baseRefOid headRefOid}}}}`;
  interface StampNode { __typename: string; number: number; url: string; updatedAt: string; repository: { nameWithOwner: string }; baseRefOid?: string; headRefOid?: string }
  const result = await gh<{ data: { repository: { issueOrPullRequest: StampNode | null } | null } }>([
    'api', '--hostname', 'github.com', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${requested.number}`,
  ], requested.url, cwd);
  const node = result.data.repository?.issueOrPullRequest;
  if (!node || !['Issue', 'PullRequest'].includes(node.__typename)) throw new Error(`Could not read ${requested.url}: no readable issue or pull request.`);
  const kind = node.__typename === 'PullRequest' ? 'pr' : 'issue';
  if (requested.expectedKind && requested.expectedKind !== kind) throw new Error(`${requested.url} identifies ${kind === 'pr' ? 'a pull request' : 'an issue'}, not the requested kind.`);
  const base = { repo: node.repository.nameWithOwner, number: node.number, url: node.url, updatedAt: node.updatedAt };
  if (kind === 'issue') return { ...base, kind };
  if (!SHA.test(node.baseRefOid ?? '') || !SHA.test(node.headRefOid ?? '')) throw new Error(`Could not read exact base and head SHAs for ${node.url}.`);
  return { ...base, kind, baseSha: node.baseRefOid!, headSha: node.headRefOid! };
}

/** Read source data only. Cache folders, git fetches, and explanation belong to callers. */
export async function readItem(input: string, opts: { cwd?: string } = {}): Promise<DisItem> {
  const cwd = opts.cwd ?? process.cwd();
  const requested = await resolveRef(input, cwd);
  const raw = await api<RawIssue>(`repos/${requested.repo}/issues/${requested.number}`, requested.url, cwd);
  const identity = linkedIssue(raw);
  if (requested.expectedKind && requested.expectedKind !== identity.kind) throw new Error(`${requested.url} identifies ${identity.kind === 'pr' ? 'a pull request' : 'an issue'}, not the requested kind.`);
  const { repo, number, url, title, kind } = identity;
  const path = `repos/${repo}/issues/${number}`;
  const [comments, reviewComments, reviews, timeline, native, detail, parent, children, blockers] = await Promise.all([
    pages<RawComment>(`${path}/comments?per_page=100`, url, cwd),
    kind === 'pr' ? pages<RawComment>(`repos/${repo}/pulls/${number}/comments?per_page=100`, url, cwd) : [],
    kind === 'pr' ? pages<RawComment>(`repos/${repo}/pulls/${number}/reviews?per_page=100`, url, cwd) : [],
    pages<{ event: string; source?: { issue?: RawIssue } }>(`${path}/timeline?per_page=100`, url, cwd),
    closingLinks(identity, kind, cwd),
    kind === 'pr' ? api<RawPr>(`repos/${repo}/pulls/${number}`, url, cwd) : null,
    kind === 'issue' ? api<RawIssue>(`${path}/parent`, url, cwd).catch((error) => { if (notFound(error)) return null; throw error; }) : null,
    kind === 'issue' && raw.sub_issues_summary?.total !== 0 ? pages<RawIssue>(`${path}/sub_issues?per_page=100`, url, cwd) : [],
    kind === 'issue' && raw.issue_dependencies_summary?.total_blocked_by !== 0 ? pages<RawIssue>(`${path}/dependencies/blocked_by?per_page=100`, url, cwd) : [],
  ]);
  const linked = new Map<string, LinkedItem>();
  const remember = (link: LinkedItem): void => {
    const key = `${link.repo.toLowerCase()}#${link.number}`;
    if (key !== `${repo.toLowerCase()}#${number}`) linked.set(key, link);
  };
  for (const event of timeline) if (event.event === 'cross-referenced' && event.source?.issue) remember(linkedIssue(event.source.issue));
  if (parent) remember(linkedIssue(parent));
  children.forEach((child) => remember(linkedIssue(child)));
  native.forEach(remember);
  const base = {
    repo, number, url, title, body: raw.body ?? '', state: detail?.merged_at ? 'merged' : raw.state.toLowerCase(),
    labels: raw.labels.map((label) => typeof label === 'string' ? label : label.name), updatedAt: raw.updated_at,
    comments: [...comments, ...reviewComments, ...reviews.filter((review) => review.body?.trim())]
      .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
      .map((comment) => ({ body: comment.body ?? '', url: comment.html_url, author: comment.user?.login ?? '' })),
    linked: [...linked.values()], blockedBy: blockers.map(linkedIssue),
  };
  if (kind === 'issue') return { ...base, kind };
  if (!detail || !SHA.test(detail.base?.sha ?? '') || !SHA.test(detail.head?.sha ?? '')) throw new Error(`Could not read exact base and head SHAs for ${url}.`);
  return { ...base, kind, baseSha: detail.base.sha, headSha: detail.head.sha };
}
