import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { analyze } from '../impact/analyze.ts';
import { git, tryGit, webUrl } from '../impact/git.ts';
import { repoTop } from '../impact/tree.ts';
import type { Facts } from '../impact/types.ts';
import { locate } from '../tools/cccc.ts';
import type { DisPr } from './types.ts';

/** Measure the exact GitHub snapshot. Thread text never supplies a command or a fetch argument. */
export async function measurePr(item: DisPr, opts: { cwd?: string; tempRoot?: string } = {}): Promise<Facts> {
  if (!/^[a-z\d-]+\/[a-z\d_.-]+$/i.test(item.repo) || !Number.isSafeInteger(item.number) || item.number < 1) {
    throw new Error('PR measurement needs a GitHub owner/repository and a positive PR number');
  }
  if (![item.baseSha, item.headSha].every((sha) => /^[a-f\d]{40}$/i.test(sha))) {
    throw new Error(`PR ${item.repo}#${item.number} needs full base and head commit SHAs`);
  }
  const base = item.baseSha.toLowerCase(), head = item.headSha.toLowerCase();
  const url = `https://github.com/${item.repo}`;
  const cwd = resolve(opts.cwd ?? process.cwd());
  const isRepo = await tryGit(cwd, ['rev-parse', '--git-dir']);
  const local = isRepo === null ? null : webUrl(await tryGit(cwd, ['config', '--get', 'remote.origin.url']));
  const same = local?.toLowerCase() === url.toLowerCase();
  // A fresh ref per invocation lets concurrent measurements share a clone without overwriting each other.
  const ref = `refs/gh-wat-dis/dis/${randomUUID()}`;
  let temporary: string | undefined;
  let root = cwd;
  try {
    if (same) root = await repoTop(cwd);
    else {
      temporary = await mkdtemp(join(resolve(opts.tempRoot ?? tmpdir()), 'gh-wat-dis-pr-'));
      root = temporary;
      await git(root, ['init', '--bare', '--quiet', '--template=']);
      await git(root, ['remote', 'add', 'origin', `${url}.git`]);
    }
    // Full blobs, no checkout or install. The two depth-one trees contain everything analysis reads.
    // Same-repository fetches retain the clone's history and leave FETCH_HEAD and branch refs alone.
    await git(root, ['fetch', '--no-tags', '--no-write-fetch-head', '--refmap=', ...(temporary ? ['--depth', '1'] : []), 'origin', base, `pull/${item.number}/head:${ref}`]);
    const gotBase = (await git(root, ['rev-parse', '--verify', `${base}^{commit}`])).trim();
    const gotHead = (await git(root, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
    if (gotBase !== base || gotHead !== head) {
      throw new Error(`PR ${item.repo}#${item.number} moved while measuring: expected base ${base} and head ${head}; fetched base ${gotBase} and head ${gotHead}. Read the PR again.`);
    }
    const shallow = (await git(root, ['rev-parse', '--is-shallow-repository'])).trim() === 'true';
    const facts = await analyze({ cwd: root, base, head, architecture: 'head', cccc: locate()?.path ?? null, ...(shallow ? { history: false } : {}) });
    // URL rewrites used for transport must not change the repository named by the measurement.
    return { ...facts, repository: url };
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    else if (same) await git(root, ['update-ref', '-d', ref]);
  }
}
