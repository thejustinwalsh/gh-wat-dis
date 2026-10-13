import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const MAX = 1024 * 1024 * 1024;
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-c', 'core.quotePath=false', ...args], { cwd, maxBuffer: MAX, encoding: 'utf8' });
  return stdout;
}

export async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try { return await git(cwd, args); } catch { return null; }
}

const revParse = async (cwd: string, ref: string): Promise<string | null> =>
  (await tryGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]))?.trim() || null;

export interface Range { base: string; head: string | null; baseRef: string; headRef: string; caveats: string[] }

/** `head` is null when the head side is the working tree. */
export async function resolveRange(cwd: string, opts: { base?: string; head?: string; workingTree?: boolean }): Promise<Range> {
  const caveats: string[] = [];
  const headRef = opts.head ?? 'HEAD';
  const headSha = await revParse(cwd, headRef);
  if (!headSha && !(opts.workingTree && !opts.head)) throw new Error(`cannot resolve head ref "${headRef}"`);
  const head = opts.workingTree ? null : headSha;
  if (opts.base) {
    const base = await revParse(cwd, opts.base);
    if (!base) throw new Error(`cannot resolve base ref "${opts.base}"`);
    return { base, head, baseRef: opts.base, headRef, caveats };
  }
  if (!headSha) {
    caveats.push('the repository has no commits; every file is reported as added');
    return { base: EMPTY_TREE, head, baseRef: '(empty tree)', headRef, caveats };
  }
  for (const cand of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) {
    const mb = (await tryGit(cwd, ['merge-base', headSha, cand]))?.trim();
    if (mb) {
      if (mb === headSha && !opts.workingTree) caveats.push(`base and head are the same commit (merge-base with ${cand}); pass --base or --working-tree`);
      return { base: mb, head, baseRef: `merge-base(${headRef}, ${cand})`, headRef, caveats };
    }
  }
  const parent = await revParse(cwd, `${headSha}~1`);
  caveats.push('no default branch found (origin/HEAD, origin/main, origin/master, main, master); base is the parent of head');
  return { base: parent ?? EMPTY_TREE, head, baseRef: parent ? `${headRef}~1` : '(empty tree)', headRef, caveats };
}

export interface DiffEntry {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-changed';
  insertions: number;
  deletions: number;
  binary: boolean;
  hunkFunctions: string[];
}

const STATUS: Record<string, DiffEntry['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type-changed' };

export async function diffEntries(cwd: string, base: string, head: string | null): Promise<DiffEntry[]> {
  const range = head ? [base, head] : [base];
  const common = ['diff', '--no-ext-diff', '--no-color', '-M'];
  const [names, nums, patch] = await Promise.all([
    git(cwd, [...common, '--name-status', '-z', ...range]),
    git(cwd, [...common, '--numstat', '-z', ...range]),
    git(cwd, [...common, '-U0', ...range]),
  ]);
  const entries = new Map<string, DiffEntry>();
  const nt = names.split('\0');
  for (let i = 0; i < nt.length - 1;) {
    const code = nt[i++]!;
    const status = STATUS[code[0]!] ?? 'modified';
    const oldPath = status === 'renamed' || status === 'copied' ? nt[i++] : undefined;
    const path = nt[i++]!;
    entries.set(path, { path, ...(oldPath ? { oldPath } : {}), status, insertions: 0, deletions: 0, binary: false, hunkFunctions: [] });
  }
  const st = nums.split('\0');
  for (let i = 0; i < st.length - 1;) {
    const [ins, del, p] = st[i++]!.split('\t');
    let path = p!;
    if (!path) { i++; path = st[i++]!; }
    const e = entries.get(path);
    if (!e) continue;
    e.binary = ins === '-';
    e.insertions = Number(ins) || 0;
    e.deletions = Number(del) || 0;
  }
  let current: DiffEntry | undefined;
  let minus = '';
  for (const line of patch.split('\n')) {
    if (line.startsWith('--- ')) minus = line.slice(6);
    else if (line.startsWith('+++ ')) current = entries.get(line === '+++ /dev/null' ? minus : line.slice(6));
    else if (current && line.startsWith('@@')) {
      const fn = /^@@ [^@]* @@ ?(.*)$/.exec(line)?.[1]?.trim();
      if (fn && !current.hunkFunctions.includes(fn)) current.hunkFunctions.push(fn);
    }
  }
  return [...entries.values()];
}

/** File lists of the commits reachable from `head` in the window, newest first. */
export async function history(cwd: string, head: string, since: Date, until: Date): Promise<string[][]> {
  const out = await tryGit(cwd, ['log', `--since=${since.toISOString()}`, `--until=${until.toISOString()}`, '--name-only', '--format=%x01', head]);
  if (!out) return [];
  return out.split('\x01').map((c) => c.split('\n').filter(Boolean)).filter((c) => c.length);
}

/** Blob contents at a ref, read through one `git cat-file --batch` process. */
export function readBlobs(cwd: string, ref: string, paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!paths.length) return Promise.resolve(out);
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', reject);
    child.on('close', () => {
      const buf = Buffer.concat(chunks);
      let pos = 0;
      for (const path of paths) {
        const nl = buf.indexOf(10, pos);
        if (nl < 0) break;
        const header = buf.toString('utf8', pos, nl);
        pos = nl + 1;
        const m = / (\w+) (\d+)$/.exec(header);
        if (!m) continue;
        const size = Number(m[2]);
        if (m[1] === 'blob') out.set(path, buf.toString('utf8', pos, pos + size));
        pos += size + 1;
      }
      resolve(out);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(paths.map((p) => `${ref}:${p}\n`).join(''));
  });
}
