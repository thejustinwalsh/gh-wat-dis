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

/**
 * What GitHub said about a failed `gh api` call. gh prints the response body on stdout and
 * one line on stderr; the error's own message is only "Command failed" and the command line.
 */
export function apiMessage(e: unknown): string {
  const x = (e ?? {}) as { stdout?: unknown; stderr?: unknown; message?: unknown };
  try {
    const j = JSON.parse(String(x.stdout ?? '')) as { message?: string; status?: string | number; errors?: (string | { message?: string; code?: string })[] };
    if (j?.message) {
      const errors = (j.errors ?? []).map((er) => (typeof er === 'string' ? er : er.message ?? er.code ?? '')).filter(Boolean);
      return `${[j.message, ...errors].join(': ').replace(/\s+/g, ' ')}${j.status ? ` (HTTP ${j.status})` : ''}`;
    }
  } catch { /* stdout held no JSON body */ }
  const line = String(x.stderr ?? '').split('\n').find((l) => l.trim());
  if (line) return line.trim().replace(/^gh: /, '');
  return String(x.message ?? e).split('\n').find((l) => l.trim()) ?? 'the GitHub API call failed';
}

export interface RelateOptions { parent?: number; blockedBy?: number[]; blocks?: number[]; remove?: boolean }
export interface RelateResult { action: string; ok: boolean; detail?: string }

/** The REST calls take an issue's database id, not its number. */
export async function relate(api: Api, repo: string, n: number, opts: RelateOptions): Promise<RelateResult[]> {
  const id = async (num: number): Promise<number> => (await api<Raw>([base(repo, num)])).id;
  const out: RelateResult[] = [];
  const attempt = async (action: string, args: () => Promise<string[]>): Promise<void> => {
    try { await api<unknown>(await args()); out.push({ action, ok: true }); }
    catch (e) { out.push({ action, ok: false, detail: (e instanceof Error ? e.message : String(e)).split('\n').find((l) => l.trim())?.slice(0, 300) }); }
  };
  if (opts.parent !== undefined) {
    const parent = opts.parent;
    if (opts.remove) {
      await attempt(`remove parent #${parent} of #${n}`, async () => [`${base(repo, parent)}/sub_issue`, '-X', 'DELETE', '-F', `sub_issue_id=${await id(n)}`]);
    } else {
      // An issue has one parent. GitHub refuses a second one unless the call says to replace the first.
      let old: Raw | null = null;
      try { old = await api<Raw | null>([`${base(repo, n)}/parent`]); } catch { old = null; }
      const action = `set parent #${parent} of #${n}`;
      if (old?.number === parent) out.push({ action, ok: true, detail: `#${parent} is already the parent` });
      else {
        await attempt(action, async () => [`${base(repo, parent)}/sub_issues`, '-X', 'POST', '-F', `sub_issue_id=${await id(n)}`, '-F', 'replace_parent=true']);
        const done = out.at(-1)!;
        if (done.ok) done.detail = `parent was ${old ? `#${old.number}` : 'none'}, now #${parent}`;
      }
    }
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
