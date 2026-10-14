import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_PARSE_BYTES, isSkipped, languageOf } from './classify.ts';
import { git, readBlobs, tryGit } from './git.ts';

/** One side of a comparison: the file list and file contents of a commit or of the working tree. */
export interface Tree {
  root: string;
  files: string[];
  has(path: string): boolean;
  read(path: string): string | undefined;
  size(path: string): number;
}

const NEEDED = /(^|\/)(package\.json|Cargo\.toml|pnpm-workspace\.yaml|[jt]sconfig[^/]*\.json|CODEOWNERS)$|^\.github\/workflows\/[^/]+\.ya?ml$/;
const wanted = (path: string): boolean => NEEDED.test(path) || (languageOf(path) !== null && !isSkipped(path));

function walk(root: string, dir = '', out: string[] = []): string[] {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!/^(node_modules|\.git|target|dist|build|vendor)$/.test(e.name)) walk(root, rel, out); } else if (e.isFile()) out.push(rel);
  }
  return out;
}

export async function repoTop(cwd: string): Promise<string> {
  return (await tryGit(cwd, ['rev-parse', '--show-toplevel']))?.trim() || cwd;
}

export async function workingTree(root: string): Promise<Tree> {
  const listed = await tryGit(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  let files: string[];
  if (listed === null) files = walk(root);
  else {
    const gone = new Set((await git(root, ['ls-files', '-z', '--deleted'])).split('\0'));
    files = [...new Set(listed.split('\0'))].filter((f) => f && !gone.has(f));
  }
  const set = new Set(files);
  return {
    root, files,
    has: (p) => set.has(p),
    read: (p) => { try { return readFileSync(join(root, p), 'utf8'); } catch { return undefined; } },
    size: (p) => { try { return statSync(join(root, p)).size; } catch { return 0; } },
  };
}

export async function commitTree(root: string, ref: string): Promise<Tree> {
  const sizes = new Map<string, number>();
  for (const row of (await git(root, ['ls-tree', '-r', '-l', '-z', ref])).split('\0')) {
    const tab = row.indexOf('\t');
    if (tab < 0) continue;
    const [, type, , size] = row.slice(0, tab).split(/\s+/);
    if (type === 'blob') sizes.set(row.slice(tab + 1), Number(size) || 0);
  }
  const files = [...sizes.keys()];
  const blobs = await readBlobs(root, ref, files.filter((f) => wanted(f) && sizes.get(f)! <= MAX_PARSE_BYTES));
  return { root, files, has: (p) => sizes.has(p), read: (p) => blobs.get(p), size: (p) => sizes.get(p) ?? 0 };
}
