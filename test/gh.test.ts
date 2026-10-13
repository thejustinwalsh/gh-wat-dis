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
  const res = await findRelated({ title: 'Checkout API returns 500 on empty cart', search: async () => { if (n++ === 0) throw new Error('rate limited'); return []; } });
  assert.equal(res.failed.length, 1);
  assert.deepEqual(res.candidates, []);
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
