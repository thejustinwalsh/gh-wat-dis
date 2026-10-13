// GitHub's own relations between issues: parent and sub-issue, blocked by and blocking.
// A real relation shows in the sidebar and in filters. A "Refs #12" line in a body does neither.

export interface IssueRef { number: number; title: string; state: string; id: number }
export interface Relations { issue: IssueRef; parent: IssueRef | null; subIssues: IssueRef[]; blockedBy: IssueRef[]; blocking: IssueRef[] }

export type Api = <T>(args: string[]) => Promise<T>;
interface Raw { number: number; title: string; state: string; id: number }
const ref = (r: Raw): IssueRef => ({ number: r.number, title: r.title, state: r.state, id: r.id });
const base = (repo: string, n: number): string => `repos/${repo}/issues/${n}`;

export async function readRelations(api: Api, repo: string, n: number): Promise<Relations> {
  const quiet = async <T>(args: string[], fallback: T): Promise<T> => { try { return await api<T>(args); } catch { return fallback; } };
  const [issue, parent, subs, blockedBy, blocking] = await Promise.all([
    api<Raw>([base(repo, n)]),
    quiet<Raw | null>([`${base(repo, n)}/parent`], null),
    quiet<Raw[]>([`${base(repo, n)}/sub_issues`, '--paginate'], []),
    quiet<Raw[]>([`${base(repo, n)}/dependencies/blocked_by`, '--paginate'], []),
    quiet<Raw[]>([`${base(repo, n)}/dependencies/blocking`, '--paginate'], []),
  ]);
  return { issue: ref(issue), parent: parent ? ref(parent) : null, subIssues: subs.map(ref), blockedBy: blockedBy.map(ref), blocking: blocking.map(ref) };
}

export interface RelateOptions { parent?: number; blockedBy?: number[]; blocks?: number[]; remove?: boolean }
export interface RelateResult { action: string; ok: boolean; detail?: string }

/** The REST calls take an issue's database id, not its number. */
export async function relate(api: Api, repo: string, n: number, opts: RelateOptions): Promise<RelateResult[]> {
  const id = async (num: number): Promise<number> => (await api<Raw>([base(repo, num)])).id;
  const out: RelateResult[] = [];
  const attempt = async (action: string, args: () => Promise<string[]>): Promise<void> => {
    try { await api<unknown>(await args()); out.push({ action, ok: true }); }
    catch (e) { out.push({ action, ok: false, detail: (e instanceof Error ? e.message : String(e)).split('\n').find((l) => l.trim())?.slice(0, 200) }); }
  };
  if (opts.parent !== undefined) {
    const parent = opts.parent;
    await attempt(`${opts.remove ? 'remove' : 'set'} parent #${parent} of #${n}`, async () =>
      [`${base(repo, parent)}/${opts.remove ? 'sub_issue' : 'sub_issues'}`, '-X', opts.remove ? 'DELETE' : 'POST', '-F', `sub_issue_id=${await id(n)}`]);
  }
  for (const blocker of opts.blockedBy ?? []) {
    await attempt(`${opts.remove ? 'remove' : 'add'} #${n} blocked by #${blocker}`, async () => (opts.remove
      ? [`${base(repo, n)}/dependencies/blocked_by/${await id(blocker)}`, '-X', 'DELETE']
      : [`${base(repo, n)}/dependencies/blocked_by`, '-X', 'POST', '-F', `issue_id=${await id(blocker)}`]));
  }
  for (const blocked of opts.blocks ?? []) {
    await attempt(`${opts.remove ? 'remove' : 'add'} #${blocked} blocked by #${n}`, async () => (opts.remove
      ? [`${base(repo, blocked)}/dependencies/blocked_by/${await id(n)}`, '-X', 'DELETE']
      : [`${base(repo, blocked)}/dependencies/blocked_by`, '-X', 'POST', '-F', `issue_id=${await id(n)}`]));
  }
  return out;
}
