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

\`\`\`text
You are working in acme/shop on this pull request.
data
\`\`\`

</details>

Closes #1
Refs #2
`;

test('lint passes a well-formed body with link lines last', () => {
  assert.deepEqual(lintBody(GOOD, { kind: 'pr' }), { errors: [], warnings: [] });
});

test('lint: a diagram on its own line is centred, with blank lines inside the div', () => {
  const body = (img: string): string => `Opening sentence.\n\n${img}\n\n## System\nText.\n`;
  const ok = lintBody(body('<div align="center">\n\n![Title](https://example.com/a.svg)\n\n</div>'), { kind: 'issue' });
  assert.deepEqual(ok, { errors: [], warnings: [] });
  const bare = lintBody(body('![Title](https://example.com/a.svg)'), { kind: 'issue' });
  assert.match(bare.warnings[0]!.msg, /not centred/);
  const tight = lintBody(body('<div align="center">\n![Title](https://example.com/a.svg)\n</div>'), { kind: 'issue' });
  assert.match(tight.errors[0]!.msg, /leave a blank line/);
  const inTable = lintBody(body('| Before | After |\n|---|---|\n| ![a](https://example.com/a.png) | ![b](https://example.com/b.png) |'), { kind: 'pr' });
  assert.deepEqual(inTable.warnings, []);
});

test('lint warns when the agent context has no code block to copy', () => {
  const plain = 'Outcome.\n\n<details>\n<summary>Agent context</summary>\n\ndata\n\n</details>\n';
  const { errors, warnings } = lintBody(plain, { kind: 'issue' });
  assert.equal(errors.length, 0);
  assert.match(warnings[0]!.msg, /holds no code block/);
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

test('related: a package runner and common flags are not identifiers', () => {
  const s = extractSignals({ title: 'Site: no page lists every command', body: 'Run `npx gh-wat-dis` with `--help`, or `npx gh-wat-dis <command> --help`. See `npx -y gh-wat-dis impact --working-tree`.' });
  assert.deepEqual(s.spans, ['<command> --help', 'impact --working-tree']);
  const other = { title: 'Fix the triage skill', body: 'Run `npx gh-wat-dis --help` first.' };
  assert.equal(score(s, other).signals.some((x) => x.kind === 'identifier'), false);
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

test('label colours: valid hex, distinct hues, stable when a surface is appended', async () => {
  const { oklchHex, surfaceColor, ROLE_COLORS } = await import('../src/gh/color.ts');
  assert.equal(oklchHex(1, 0, 0), 'ffffff');
  assert.equal(oklchHex(0, 0, 0), '000000');
  const twelve = Array.from({ length: 12 }, (_, i) => surfaceColor(i));
  for (const c of [...twelve, ...Object.values(ROLE_COLORS)]) assert.match(c, /^[0-9a-f]{6}$/);
  assert.equal(new Set(twelve).size, 12);
  const chan = (hex: string): number[] => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const dist = (a: string, b: string): number => Math.hypot(...chan(a).map((v, i) => v - chan(b)[i]!));
  for (let i = 1; i < twelve.length; i++) assert.ok(dist(twelve[i - 1]!, twelve[i]!) > 40, `neighbours ${i - 1} and ${i} look alike`);
  assert.equal(surfaceColor(3), Array.from({ length: 20 }, (_, i) => surfaceColor(i))[3]);
  const luma = (hex: string): number => { const [r, g, b] = chan(hex); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
  const lumas = twelve.map(luma);
  assert.ok(Math.max(...lumas) - Math.min(...lumas) < 45, 'surfaces share one lightness');
});

test('milestone: counts issues only, finds what is in review and blocked, and rates without dates', async () => {
  const { milestoneStatus, byVersion, doneWhen } = await import('../src/gh/milestone.ts');
  const now = new Date('2026-10-13T12:00:00Z');
  const issue = (number: number, state: string, closed?: string, subs = 0) => ({ number, title: `t${number}`, state, closed_at: closed ?? null, updated_at: closed ?? '2026-10-01T00:00:00Z', sub_issues_summary: { total: subs } });
  const base = {
    milestone: { title: 'v0.2.0', number: 2, state: 'open', description: 'Goal.\n\n**Done when**\n- first thing\n- second thing\n\n**In scope:** x\n**Tracking:** #1' },
    openMilestones: ['v0.10.0', 'v0.2.0', 'v1.0.0'],
    items: [issue(1, 'open', undefined, 4), issue(2, 'closed', '2026-10-12T00:00:00Z'), issue(3, 'open'), issue(4, 'open'), { ...issue(9, 'closed', '2026-10-12T00:00:00Z'), pull_request: {} }],
    blockedBy: new Map([[4, [{ number: 3, title: 't3', state: 'open' }]]]),
    openPrs: [{ number: 20, closes: [3] }],
    now,
  };
  const s = milestoneStatus(base);
  assert.equal(s.tracking, 1);
  assert.equal(s.trackingFrom, 'description');
  assert.deepEqual(Object.keys(milestoneStatus({ ...base, blockedBy: new Map([[4, [{ number: 3, title: 't3', state: 'open', body: 'x'.repeat(5000), user: {} } as never]]]) }).open[1]!.blockedBy[0]!).sort(), ['inMilestone', 'number', 'state', 'title'], 'a blocker is four fields, not the raw API object');
  assert.deepEqual(s.counts, { total: 3, closed: 1, open: 2, inReview: 1, blocked: 1, blockedOutside: 0, closedLast7Days: 1 });
  assert.equal(s.status, 'moving');
  assert.equal(s.milestone.current, true, 'v0.2.0 comes before v0.10.0');
  assert.deepEqual(s.doneWhen, ['first thing', 'second thing']);
  assert.deepEqual(s.open.map((o) => [o.number, o.inReview, o.blockedBy.map((b) => b.inMilestone)]), [[3, [20], []], [4, [], [true]]]);

  const outside = milestoneStatus({ ...base, blockedBy: new Map([[3, [{ number: 77, title: 'other', state: 'open' }]]]) });
  assert.equal(outside.status, 'blocked');
  assert.match(outside.reason, /#3 waits on #77/);
  const stalled = milestoneStatus({ ...base, openPrs: [], blockedBy: new Map(), now: new Date('2026-10-30T00:00:00Z') });
  assert.equal(stalled.status, 'stalled');
  const done = milestoneStatus({ ...base, items: [issue(1, 'open', undefined, 2), issue(2, 'closed', '2026-10-12T00:00:00Z')] });
  assert.equal(done.status, 'done');
  assert.deepEqual(['v1.0.0', 'v0.10.0', 'v0.2.0'].sort(byVersion), ['v0.2.0', 'v0.10.0', 'v1.0.0']);
  assert.deepEqual(doneWhen('no list here'), []);
  assert.ok(!('dueOn' in s.milestone) && !JSON.stringify(s).includes('due'), 'a status carries no date');
});

test('issues: reads type and surfaces from the config, and says what is missing', async () => {
  const { issueRows } = await import('../src/gh/issues.ts');
  const { defaultConfig } = await import('../src/cli/config.ts');
  const cfg = defaultConfig({ owner: 'o', name: 'r' });
  cfg.labels.surfaces = [{ name: 'site', description: 's' }, { name: 'ci', description: 'c' }];
  const raw = (number: number, labels: string[], extra: object = {}) => ({ number, title: `t${number}`, state: 'open', comments: 0, updated_at: 'x', labels: labels.map((name) => ({ name })), milestone: null, ...extra });
  const rows = issueRows(cfg, [
    raw(1, ['task'], { sub_issues_summary: { total: 3, completed: 1 }, milestone: { title: 'v1' } }),
    raw(2, ['bug', 'site', 'ci', 'agents']),
    raw(3, ['bug', 'feature', 'site']),
    raw(4, ['wontfix']),
    raw(5, ['task', 'site'], { pull_request: {} }),
  ]);
  const by = new Map(rows.map((r) => [r.number, r]));
  assert.equal(rows.length, 4, 'pull requests are left out');
  assert.deepEqual([by.get(1)!.tracking, by.get(1)!.missing, by.get(1)!.type], [true, [], 'Task'], 'a tracking issue needs no surface');
  assert.deepEqual([by.get(2)!.type, by.get(2)!.surfaces, by.get(2)!.agents, by.get(2)!.missing], ['Bug', ['site', 'ci'], true, []]);
  assert.deepEqual(by.get(3)!.missing, ['one type']);
  assert.deepEqual([by.get(4)!.missing, by.get(4)!.otherLabels], [['type', 'surface'], ['wontfix']]);
  const org = defaultConfig({ owner: 'o', name: 'r', issueTypes: ['Bug'] });
  const typed = issueRows(org, [raw(9, ['bug', 'wontfix'], { type: { name: 'Bug' } })])[0]!;
  assert.deepEqual([typed.type, typed.otherLabels], ['Bug', ['bug', 'wontfix']], 'with issue types, a label named "bug" is one more label');
});

test('survey: counts what open issues lack and describes bodies without rating them', async () => {
  const { bodyFacts, issueNumbers, survey, surveyRows } = await import('../src/gh/survey.ts');
  const { defaultConfig } = await import('../src/cli/config.ts');

  const facts = bodyFacts('## Summary\r\nText.\n\n```md\n## Do\n- [x] in code\n```\n## evidence\n- [x] done by someone\n* [ ] open\n1. [X] also done\n<details><summary>Agent context</summary>x</details>');
  assert.deepEqual(facts, { chars: facts.chars, opensWithHeading: true, sections: ['Evidence'], otherHeadings: 1, checkedTasks: 2, openTasks: 1, agentContext: true });
  assert.deepEqual(bodyFacts(null), { chars: 0, opensWithHeading: false, sections: [], otherHeadings: 0, checkedTasks: 0, openTasks: 0, agentContext: false });
  assert.equal(bodyFacts('Plain opening.\n\n## Do\n- [ ] x').opensWithHeading, false);
  assert.deepEqual(issueNumbers('253 rewritten\n#236 kept: waits on #12\n\n  250 skip, a workflow writes it\nnote with 99 in it\n'), [253, 236, 250]);

  const cfg = defaultConfig({ owner: 'o', name: 'r', issueTypes: ['Task', 'Bug', 'Feature'] });
  cfg.labels.surfaces = [{ name: 'site', description: 's' }];
  const raw = (number: number, labels: string[], extra: object = {}) => ({
    number, title: `t${number}`, state: 'open', comments: 0, updated_at: `2026-10-${String(number).padStart(2, '0')}T00:00:00Z`,
    labels: labels.map((name) => ({ name })), milestone: null, body: 'Text.', user: { login: 'Me' }, ...extra,
  });
  const input = {
    repo: 'o/r', organization: true, viewer: { login: 'me', permission: 'WRITE' }, cfg,
    issues: [
      raw(1, ['site'], { type: { name: 'Bug' }, milestone: { title: 'v0.10.0' } }),
      raw(2, ['bug', 'needs-repro'], { user: { login: 'other' }, body: '' }),
      raw(3, ['enhancement', 'site'], { type: { name: 'Feature' }, milestone: { title: 'v0.2.0' }, body: '# Title\n- [x] kept' }),
      raw(4, [], { sub_issues_summary: { total: 2, completed: 0 }, type: { name: 'Task' } }),
      raw(5, [], { pull_request: {} }),
    ],
    labels: [
      { name: 'site', description: 's', color: 'ffffff' }, { name: 'bug', description: 'b', color: 'd73a4a' },
      { name: 'enhancement', description: 'e', color: 'a2eeef' }, { name: 'needs-repro', description: '', color: '000000' },
    ],
    milestones: [
      { title: 'v0.10.0', number: 2, state: 'open', description: 'Goal.\n\n**Done when**\n- a\n\n**Tracking:** #4', due_on: null, open_issues: 1, closed_issues: 0 },
      { title: 'v0.2.0', number: 1, state: 'open', description: '', due_on: '2026-12-01T08:00:00Z', open_issues: 1, closed_issues: 3 },
    ],
  };

  const rows = surveyRows(input);
  assert.deepEqual(rows.map((r) => r.number), [3, 1, 4, 2], 'the current milestone first, then later ones, then the backlog by newest update');
  assert.deepEqual(rows.map((r) => r.mine), [true, true, true, false], 'the author match ignores case');
  assert.deepEqual(rows.find((r) => r.number === 2)!.otherLabels, ['bug', 'needs-repro']);

  const s = survey(input);
  assert.deepEqual(s.counts, { openIssues: 4, openPrs: 1, byViewer: 3, byOthers: 1, noType: 1, severalTypes: 0, noSurface: 1, noMilestone: 1, tracking: 1 });
  assert.deepEqual(s.bodies, { empty: 1, opensWithHeading: 1, noFormatSection: 3, withCheckedTasks: 1 });
  assert.deepEqual(s.labels.create, ['agents']);
  assert.deepEqual(s.labels.other.map((l) => [l.name, l.openIssues, l.type, l.untyped]), [['bug', 1, 'Bug', 1], ['enhancement', 1, 'Feature', 0], ['needs-repro', 1, null, 0]]);
  assert.deepEqual(s.milestones.map((m) => [m.title, m.current, m.dueOn, m.description, m.doneWhen, m.tracking]), [
    ['v0.2.0', true, '2026-12-01T08:00:00Z', false, 0, null], ['v0.10.0', false, null, true, 1, 4],
  ]);
  assert.ok(!/score|verdict|grade|quality/i.test(JSON.stringify(s)), 'a survey states facts and rates nothing');

  const user = survey({ ...input, cfg: defaultConfig({ owner: 'o', name: 'r' }), organization: false });
  assert.deepEqual([user.owner, user.types.source, user.labels.surfaces], ['user', 'label', 0]);
  assert.equal(user.counts.noType, 3, 'on a user repository the type is a label, and "bug" is one');
});
