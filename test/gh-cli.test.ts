import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig } from '../src/cli/config.ts';

const cli = fileURLToPath(new URL('../src/bin.ts', import.meta.url));

function fixture(t: { after: (fn: () => void) => void }) {
  const cwd = mkdtempSync(join(tmpdir(), 'wat-gh-cli-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const bin = join(cwd, 'bin');
  const log = join(cwd, 'calls.jsonl');
  mkdirSync(bin);
  writeFileSync(join(cwd, 'package.json'), '{}');
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.WAT_GH_LOG, JSON.stringify({ args, target: process.env.GH_REPO ?? null }) + '\\n');
const repo = process.env.GH_REPO || 'local/clone';
const milestone = { number: 1, title: 'v1', state: 'open', description: '', due_on: null, open_issues: 1, closed_issues: 0 };
const issue = { number: 12, title: 'An old issue', state: 'open', body: 'Needs work.', comments: 0, updated_at: '2000-01-01T00:00:00Z', labels: [{ name: 'local-surface' }], milestone: null, type: { name: 'Remote type' }, user: { login: 'reader' }, issue_dependencies_summary: { total_blocked_by: 0 } };
let result;
if (args[0] === 'repo') {
  if (process.env.WAT_GH_FAIL) process.exit(1);
  if (process.env.GH_REPO && args[2] !== process.env.GH_REPO) process.exit(1);
  result = { nameWithOwner: repo, defaultBranchRef: { name: 'main' }, isInOrganization: true, viewerPermission: 'ADMIN' };
} else if (args[0] === 'label') result = [];
else if (args[0] === 'issue') result = { number: 12, title: 'Old issue needs work', body: 'A detailed issue body.' };
else if (args[0] === 'pr' && args[1] === 'list') result = [];
else if (args[0] === 'pr' && args[1] === 'view') result = { body: '', baseRefName: 'main', commits: [], closingIssuesReferences: [] };
else if (args[0] === 'api') {
  const path = args[1];
  if (path === 'graphql') result = { data: { repository: { milestone: { issues: { pageInfo: { hasNextPage: false }, nodes: [] } } } } };
  else if (path === 'user') result = { login: 'reader' };
  else if (args.includes('search/issues')) result = { items: [] };
  else if (path.includes('/milestones?')) result = [milestone];
  else if (path.includes('/issues?milestone=')) result = [];
  else if (path.includes('/issues?state=')) result = [issue, { ...issue, number: 13, type: null, milestone: { title: 'v1' }, sub_issues_summary: { total: 2, completed: 0 } }];
}
if (result === undefined) { process.stderr.write('Unexpected gh call: ' + JSON.stringify(args)); process.exit(1); }
process.stdout.write(JSON.stringify(result));
`, { mode: 0o755 });
  const config = (repo: string) => {
    const [owner, name] = repo.split('/');
    const cfg = defaultConfig({ owner, name });
    cfg.labels.surfaces = [{ name: 'local-surface', description: 'Local only' }];
    cfg.triage.staleIssueDays = 100000;
    mkdirSync(join(cwd, '.agents/gh-wat-dis'), { recursive: true });
    writeFileSync(join(cwd, '.agents/gh-wat-dis/config.json'), JSON.stringify(cfg));
  };
  const invoke = (args: string[], target: string | null = 'remote/target', fail = false) => {
    writeFileSync(log, '');
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, WAT_GH_LOG: log };
    if (target === null) delete env.GH_REPO; else env.GH_REPO = target;
    if (fail) env.WAT_GH_FAIL = '1';
    const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8' });
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { args: string[]; target: string | null });
    return { ...result, calls };
  };
  return { config, invoke };
}

test('repoInfo: GH_REPO is passed to gh repo view outside a clone; unset uses the clone', (t) => {
  const { invoke } = fixture(t);
  for (const target of ['remote/target', null]) {
    const result = invoke(['milestone'], target);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).milestone.title, 'v1');
    assert.deepEqual(result.calls[0]!.args.slice(0, target ? 3 : 2), target ? ['repo', 'view', target] : ['repo', 'view']);
    if (!target) assert.equal(result.calls[0]!.args[2], '--json');
    assert.ok(result.calls.some((c) => c.args[1]?.startsWith(`repos/${target ?? 'local/clone'}/milestones?`)));
    assert.ok(result.calls.some((c) => c.args[0] === 'pr' && c.args[1] === 'list'));
    assert.ok(result.calls.every((c) => c.target === target));
  }
});

test('repoInfo: an unavailable GH_REPO names the explicit target in its error', (t) => {
  const { invoke } = fixture(t);
  const result = invoke(['milestone'], 'remote/missing', true);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GH_REPO=remote\/missing/);
  assert.doesNotMatch(result.stderr, /Run inside a clone/);
});

test('survey shares repoInfo and implicit gh label calls keep GH_REPO', (t) => {
  const { config, invoke } = fixture(t);
  config('REMOTE/TARGET');
  const result = invoke(['survey']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.repo, 'remote/target');
  assert.equal(report.owner, 'organization');
  assert.equal(report.viewer.permission, 'ADMIN');
  assert.ok(result.calls[0]!.args.includes('remote/target'));
  assert.ok(result.calls.some((c) => c.args[0] === 'label' && c.target === 'remote/target'));
});

test('audit: mismatched config skips label and field checks while running the other checks with defaults', (t) => {
  const { config, invoke } = fixture(t);
  config('local/clone');
  const result = invoke(['audit', '--check', 'stale-issues,labels,missing-fields']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.repo, 'remote/target');
  assert.deepEqual(report.checks.map((c: { check: string }) => c.check), ['stale-issues']);
  assert.equal(report.checks[0].count, 2);
  assert.equal(report.thresholds.staleIssueDays, 60);
  assert.match(result.stderr, /local config names local\/clone; GitHub target is remote\/target/);
  assert.match(result.stderr, /Skipping config checks: missing-fields, labels/);
  assert.match(result.stderr, /default stale thresholds/);
  assert.ok(!result.calls.some((c) => c.args[0] === 'label'));
});

test('audit: a matching config keeps its checks and thresholds, and gh label/pr calls agree on GH_REPO', (t) => {
  const { config, invoke } = fixture(t);
  config('remote/target');
  const result = invoke(['audit', '--check', 'stale,labels,missing-fields']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.thresholds.staleIssueDays, 100000);
  assert.equal(report.checks.find((c: { check: string }) => c.check === 'stale-issues').count, 0);
  assert.equal(report.checks.length, 4);
  for (const command of ['label', 'pr']) assert.ok(result.calls.some((c) => c.args[0] === command && c.target === 'remote/target'));
  assert.equal(result.stderr, '');
});

test('issues: config mismatch keeps native facts and marks config fields unevaluated', (t) => {
  const { config, invoke } = fixture(t);
  config('local/clone');
  const result = invoke(['issues']);
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(result.stdout);
  const issue = rows.find((r: { number: number }) => r.number === 12);
  assert.equal(issue.type, 'Remote type');
  assert.equal(issue.milestone, null);
  assert.equal(issue.tracking, false);
  for (const field of ['surfaces', 'agents', 'priority', 'size', 'missing', 'otherLabels']) assert.equal(issue[field], null);
  assert.equal(rows.find((r: { number: number }) => r.number === 13).tracking, true);
  assert.match(result.stderr, /null \(not evaluated\)/);
  const queued = invoke(['issues', '--queue']);
  assert.deepEqual(JSON.parse(queued.stdout).map((r: { number: number }) => r.number), [12]);
});

test('labels and survey reject mismatched config before reading or changing the remote repository', (t) => {
  const { config, invoke } = fixture(t);
  config('local/clone');
  for (const command of ['labels', 'survey']) {
    const result = invoke([command]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /local config names local\/clone; GitHub target is remote\/target/);
    assert.equal(result.calls.length, 1);
  }
});

test('related and links keep GH_REPO on implicit gh issue/pr views', (t) => {
  const { invoke } = fixture(t);
  for (const [command, flag, ghCommand] of [['related', '--issue', 'issue'], ['links', '--pr', 'pr']]) {
    const result = invoke([command!, flag!, '12']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.calls.some((c) => c.args[0] === ghCommand && c.args[1] === 'view' && c.target === 'remote/target'));
    assert.ok(result.calls.some((c) => c.args[0] === 'repo' && c.args[2] === 'remote/target'));
  }
});
