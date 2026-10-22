import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { USE, defaultConfig } from './config.ts';
import type { Use } from './config.ts';
import { CONFIG_REL, TMP_DIR, UsageError, parseArgs, repoRoot, run } from './util.ts';

import { ensureDisIgnore } from './dis-ignore.ts';

interface Repo { owner: string; name: string; defaultBranch: string; remote: boolean }

function detectRepo(cwd: string): Repo {
  const gh = run('gh', ['repo', 'view', '--json', 'owner,name,defaultBranchRef'], { cwd });
  if (gh) {
    const j = JSON.parse(gh) as { owner: { login: string }; name: string; defaultBranchRef?: { name?: string } };
    return { owner: j.owner.login, name: j.name, defaultBranch: j.defaultBranchRef?.name || 'main', remote: true };
  }
  const url = run('git', ['remote', 'get-url', 'origin'], { cwd }) ?? '';
  const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  const branch = run('git', ['symbolic-ref', '--short', 'HEAD'], { cwd }) ?? 'main';
  return { owner: m?.[1] ?? '', name: m?.[2] ?? '', defaultBranch: branch, remote: false };
}

function ghList<T>(cwd: string, args: string[]): T[] {
  const out = run('gh', args, { cwd });
  try { return out ? (JSON.parse(out) as T[]) : []; } catch { return []; }
}

const HELP = `Usage: npx gh-wat-dis init [--use always|ask|never] [--dry-run] [--force]

Write the repository config at ${CONFIG_REL}: policy, labels, issue types, milestones, architecture map.

  --use <mode>     when agents use gh-wat-dis here: always (default), ask or never
  --dry-run, -n    print the config and write nothing
  --force, -f      write a new config over an existing one
`;

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['force', 'dry-run', 'help'], strings: ['use'], aliases: { '-n': '--dry-run', '-f': '--force', '-h': '--help' } });
  if (args.help) { process.stdout.write(HELP); return 0; }
  const use = (args.use ?? 'always') as Use;
  if (!USE.includes(use)) throw new UsageError(`--use must be one of ${USE.join(', ')}`);

  const root = repoRoot();
  const path = join(root, CONFIG_REL);
  if (existsSync(path) && !args.force) {
    console.log(`exists   ${path}`);
    console.log('Not changed. Edit the file, or pass --force to write a new one.');
    return 0;
  }

  const repo = detectRepo(root);
  // Issue types belong to an organization. A repository under a user account has none.
  const typesOut = repo.remote
    ? run('gh', ['api', 'graphql', '-f', `query=query{repository(owner:"${repo.owner}",name:"${repo.name}"){issueTypes(first:25){nodes{name}}}}`, '--jq', '[.data.repository.issueTypes.nodes[].name] | join("\n")'], { cwd: root })
    : null;
  const issueTypes = (typesOut ?? '').split('\n').map((t) => t.trim()).filter(Boolean);
  const milestones = repo.remote
    ? ghList<{ title: string }>(root, ['api', 'repos/{owner}/{repo}/milestones?state=all&per_page=20']).map((m) => m.title)
    : [];
  const text = JSON.stringify(defaultConfig({ ...repo, use, issueTypes, milestones }), null, 2) + '\n';

  if (args['dry-run']) {
    console.log(`would write ${path}\n`);
    process.stdout.write(text);
    return 0;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  console.log(`write    ${path}`);

  // A token file for harnesses that can only read an environment variable. It must never be committed.
  const localIgnore = join(dirname(path), '.gitignore');
  if (!existsSync(localIgnore)) {
    writeFileSync(localIgnore, '.env\n.env.*\n');
    console.log(`write    ${localIgnore}  (ignore .env)`);
  }

  if (ensureDisIgnore(root)) console.log(`update   ${localIgnore}  (ignore dis/)`);

  const gi = join(root, '.gitignore');
  const cur = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  if (!cur.split('\n').some((l) => l.trim() === `${TMP_DIR}/`)) {
    appendFileSync(gi, `${cur && !cur.endsWith('\n') ? '\n' : ''}${TMP_DIR}/\n`);
    console.log(`update   ${gi}  (ignore ${TMP_DIR}/)`);
  }

  console.log(`\nRepository: ${repo.owner || '?'}/${repo.name || '?'}, default branch ${repo.defaultBranch}`);
  if (!repo.remote) console.log('No GitHub remote found through gh. Fill in repo.owner and repo.name when the remote exists.');
  console.log(issueTypes.length
    ? `Issue types: ${issueTypes.join(', ')}. ${milestones.length} milestones.`
    : `Issue types: none here, because GitHub offers them to organization repositories only. Type is a label in this repository: task, bug, feature. ${milestones.length} milestones.`);
  console.log('Labels: run "npx gh-wat-dis labels --text" to see what to create, then "npx gh-wat-dis labels apply". Map the architecture first to get one label for each product surface.');
  console.log(`policy.use is "${use}". Next: review the file, map the architecture (wat-architecture skill), commit it.`);
  return 0;
}
