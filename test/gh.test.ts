import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLinks, parseRefs } from '../src/gh/links.ts';
import { buildQueries, extractSignals, findRelated, score } from '../src/gh/related.ts';
import { lintBody } from '../src/lint/body.ts';

const nums = (a: { number?: number }[]): number[] => a.map((x) => x.number ?? -1).sort((x, y) => x - y);

test('closing keywords close, bare refs only mention', () => {
  const r = parseRefs('Closes #12\nRefs #13\nfixes: o/r#14 and resolved https://github.com/o/r/issues/15\nSee #16.', { repo: 'o/r' });
  assert.deepEqual(nums(r.closing), [12, 14, 15]);
  assert.deepEqual(nums(r.mentions), [13, 16]);
});

test('negated keyword still closes and is flagged', () => {
  const r = parseRefs('This does not fix #12 yet.', { repo: 'o/r' });
  assert.deepEqual(nums(r.closing), [12]);
  assert.equal(r.warnings[0]?.code, 'negated-keyword');
});

test('one keyword does not cover a list', () => {
  const r = parseRefs('Closes #1, #2 and #3', { repo: 'o/r' });
  assert.deepEqual(nums(r.closing), [1]);
  assert.deepEqual(nums(r.warnings.filter((w) => w.code === 'list-without-keyword')), [2, 3]);
});

test('keywords inside code are ignored', () => {
  const r = parseRefs('Run `fixes #9`.\n```\ncloses #10\n```\nCloses #11', { repo: 'o/r' });
  assert.deepEqual(nums(r.closing), [11]);
});

test('intended list catches unintended and missing closes', () => {
  const res = analyzeLinks({
    body: 'Closes #1\nRefs #2', repo: 'o/r', intended: [1, 2],
    commits: [{ sha: 'abcdef1234', message: 'wip: fix #7 for now' }],
  });
  assert.deepEqual(nums(res.willClose), [1, 7]);
  assert.deepEqual(res.errors.map((e) => [e.code, e.number]).sort(), [['missing-close', 2], ['unintended-close', 7]]);
  assert.ok(res.warnings.some((w) => w.code === 'commit-only' && w.number === 7));
});

test('--closes none rejects any close', () => {
  const res = analyzeLinks({ body: 'Fixes #3', repo: 'o/r', intended: [] });
  assert.equal(res.errors[0]?.code, 'unintended-close');
});

test('non-default base and sidebar links are reported', () => {
  const res = analyzeLinks({ body: 'Closes #1', repo: 'o/r', base: 'release', defaultBranch: 'main', github: [{ repo: 'o/r', number: 5 }] });
  const codes = res.warnings.map((w) => w.code);
  assert.ok(codes.includes('non-default-base'));
  assert.ok(codes.includes('linked-in-sidebar'));
  assert.ok(codes.includes('not-linked-on-github'));
  assert.deepEqual(nums(res.willClose), [1, 5]);
});

test('signals pull paths, identifiers and error text', () => {
  const s = extractSignals({
    title: 'Payments worker: duplicate charge when the webhook retries',
    body: 'Fails in `src/payments/charge.ts:42`.\n\n```\nError: idempotency key reused for charge ch_123\n```\nSee `ChargeService.retry`.',
  });
  assert.ok(s.paths.includes('src/payments/charge.ts'));
  assert.ok(s.spans.includes('ChargeService.retry'));
  assert.ok(s.errors[0]?.startsWith('Error: idempotency key reused'));
  assert.ok(s.terms.includes('webhook') && !s.terms.includes('the'));
  assert.ok(buildQueries(s).some((q) => q.why === 'file path'));
});

test('exact signals outrank shared words', async () => {
  const draft = { title: 'Duplicate charge when the webhook retries', body: 'Fails in `src/payments/charge.ts`. Error: idempotency key reused for charge' };
  const rows = [
    { number: 1, title: 'Webhook retries are slow', body: 'Latency on retries.', state: 'OPEN' },
    { number: 2, title: 'Customer charged twice', body: 'Trace ends in src/payments/charge.ts with Error: idempotency key reused for charge', state: 'CLOSED', stateReason: 'completed' },
    { number: 3, title: 'Docs typo', body: 'nothing shared', state: 'OPEN' },
  ];
  const res = await findRelated({ ...draft, self: 3, search: async () => rows });
  assert.equal(res.candidates[0]?.number, 2);
  assert.ok(res.candidates[0]?.signals.some((s) => s.label === 'exact'));
  assert.ok(!res.candidates.some((c) => c.number === 3));
  const sig = extractSignals(draft);
  assert.ok(score(sig, rows[1]!).points > score(sig, rows[0]!).points);
});

test('a failed query does not sink the search', async () => {
  let n = 0;
  const res = await findRelated({ title: 'Checkout API returns 500 on empty cart', search: async () => { if (n++ === 0) throw new Error('boom'); return []; } });
  assert.equal(res.failed.length, 1);
  assert.equal(res.complete, false);
  assert.deepEqual(res.candidates, []);
  let calls = 0;
  const retried = await findRelated({ title: 'Checkout API returns 500 on empty cart', retryMs: 1, search: async () => { if (calls++ === 0) throw new Error('HTTP 403: API rate limit exceeded'); return []; } });
  assert.equal(retried.complete, true);
  const { toMarkdown } = await import('../src/gh/related.ts');
  const dead = await findRelated({ title: 'Checkout API returns 500 on empty cart', retryMs: 1, search: async () => { throw new Error('HTTP 403: API rate limit exceeded'); } });
  assert.match(toMarkdown(dead), /^Could not search/);
  assert.doesNotMatch(toMarkdown(dead), /No related/);
});

const GOOD = `The API gateway validates tokens once at the edge.

## System
The four services behind the gateway stop validating.

## Follow-ups
- #9 Remove the old check: waits for release 1.5

<details>
<summary>Agent context</summary>

data

</details>

Closes #1
Refs #2
`;

test('lint passes a well-formed body with link lines last', () => {
  assert.deepEqual(lintBody(GOOD, { kind: 'pr' }), { errors: [], warnings: [] });
});

test('lint is a backstop: it does not police wording', () => {
  const wordy = 'This PR basically leverages a robust approach in order to utilize the cache, which might potentially help.\n';
  assert.deepEqual(lintBody(wordy, { kind: 'pr' }), { errors: [], warnings: [] });
});

test('lint catches what GitHub would break', () => {
  const bad = 'Outcome.\n\n![d](./missing.svg)\n<svg></svg>\n\n<details>\n<summary>Agent context</summary>\n\nx\n\n</details>\n\nMore prose.\n';
  const { errors } = lintBody(bad, { kind: 'issue', exists: () => false });
  assert.equal(errors.length, 3);
  const ms = lintBody('Goal.\n\n> [!NOTE]\n> x\n\n![d](./a.svg)\n', { kind: 'milestone', exists: () => true });
  assert.equal(ms.errors.length, 2);
  assert.equal(lintBody('', { kind: 'issue' }).errors[0]?.msg, 'body is empty');
});

test('related: product names and plain words in backticks are not identifiers', () => {
  const s = extractSignals({ title: 'Site on GitHub Pages', body: 'Render with `diagram` and call `retryCharge` from `event.id`. Uses TypeScript and OrderPlacedEvent.' });
  assert.ok(!s.idents.includes('GitHub') && !s.idents.includes('TypeScript'));
  assert.ok(!s.spans.includes('diagram'));
  assert.ok(s.spans.includes('retryCharge') && s.spans.includes('event.id'));
  assert.ok(s.idents.includes('OrderPlacedEvent'));
});

test('labels: agents plus one per surface; other labels are extra and never dropped by default', async () => {
  const { planLabels } = await import('../src/gh/labels.ts');
  const { defaultConfig } = await import('../src/cli/config.ts');
  const cfg = defaultConfig({ owner: 'o', name: 'r' });
  cfg.architecture.elements = [
    { id: 'site', name: 'Site', type: 'container', description: 'Shows the product', paths: ['docs/**'] },
    { id: 'stripe', name: 'Stripe', type: 'system', external: true, paths: [] },
    { id: 'user', name: 'User', type: 'person', paths: [] },
  ];
  assert.equal(cfg.issues.typeSource, 'label', 'a repository with no issue types uses type labels');
  const plan = planLabels(cfg, [{ name: 'bug', description: 'x', color: 'd73a4a' }, { name: 'Agents', description: 'old', color: 'ffffff' }, { name: 'wontfix', description: '', color: 'ffffff' }]);
  assert.equal(plan.surfacesFrom, 'architecture');
  assert.deepEqual(plan.create.map((l) => [l.name, l.role]), [['task', 'type'], ['feature', 'type'], ['site', 'surface']]);
  assert.deepEqual(plan.update.map((l) => l.name), ['bug', 'agents']);
  assert.deepEqual(plan.extra.map((l) => l.name), ['wontfix']);
  const org = defaultConfig({ owner: 'o', name: 'r', issueTypes: ['Task', 'Bug', 'Feature'] });
  assert.equal(org.issues.typeSource, 'issue-type');
  assert.ok(!planLabels(org, []).create.some((l) => l.role === 'type'), 'an organization repository gets no type labels');
  cfg.issues = { types: [], typeSource: 'issue-type' };
  cfg.labels.surfaces = [{ name: 'checkout', description: 'The checkout flow' }];
  assert.deepEqual(planLabels(cfg, []).create.map((l) => [l.name, l.role]), [['agents', 'agents'], ['checkout', 'surface']]);
});

test('relations: reads all four kinds and sends database ids when it writes', async () => {
  const { readRelations, relate } = await import('../src/gh/relations.ts');
  const calls: string[][] = [];
  const issue = (n: number) => ({ number: n, title: `t${n}`, state: 'open', id: 1000 + n });
  const api = async <T>(args: string[]): Promise<T> => {
    calls.push(args);
    const path = args[0]!;
    if (args.includes('POST') || args.includes('DELETE')) return null as T;
    if (path.endsWith('/parent')) return issue(1) as T;
    if (path.endsWith('/sub_issues')) return [] as T;
    if (path.endsWith('/blocked_by')) return [issue(3)] as T;
    if (path.endsWith('/blocking')) return [] as T;
    return issue(Number(path.split('/').pop())) as T;
  };
  const rel = await readRelations(api, 'o/r', 7);
  assert.equal(rel.parent?.number, 1);
  assert.deepEqual(rel.blockedBy.map((r) => r.number), [3]);
  calls.length = 0;
  const res = await relate(api, 'o/r', 7, { parent: 1, blockedBy: [3] });
  assert.ok(res.every((r) => r.ok));
  assert.ok(calls.some((c) => c[0] === 'repos/o/r/issues/1/sub_issues' && c.includes('sub_issue_id=1007')));
  assert.ok(calls.some((c) => c[0] === 'repos/o/r/issues/7/dependencies/blocked_by' && c.includes('issue_id=1003')));
});
