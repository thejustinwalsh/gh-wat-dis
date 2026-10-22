import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { render, renderHtml, renderHtmlDocument } from '../src/diagram/index.ts';
import { relationshipIds } from '../src/diagram/svg.ts';
import { escapeXml } from '../src/diagram/measure.ts';
import type { DiagramSpec } from '../src/spec.ts';

const base = (): DiagramSpec => ({
  title: 'Orders', type: 'container',
  elements: [
    { id: 'web', type: 'container', name: 'Web', technology: 'TypeScript', description: 'Storefront' },
    { id: 'api', type: 'container', name: 'API', technology: 'Rust', description: 'Order API', status: 'changed' },
  ],
  relationships: [{ from: 'web', to: 'api', label: 'Places orders', technology: 'HTTPS', status: 'added' }],
});
const ids = (html: string): string[] => [...html.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]!);
const geometry = (svg: string): string[] => svg.match(/<(?:path|rect|circle|text)\b[^>]*>/g) ?? [];
const cli = (...args: string[]) => spawnSync(process.execPath, [fileURLToPath(new URL('./diagram-run.ts', import.meta.url)), ...args], { encoding: 'utf8' });

test('HTML is self-contained, accessible, and escapes all supplied text and attributes', async () => {
  const spec = base();
  const hostile = `\"><script>alert('x')</script><style>body{display:none}</style>&`;
  spec.title = hostile;
  spec.scope = hostile;
  spec.elements[0]!.id = hostile;
  spec.elements[0]!.name = hostile;
  spec.relationships[0]!.from = hostile;
  spec.relationships[0]!.label = hostile;
  spec.relationships[0]!.technology = hostile;
  const html = await renderHtml(spec, { labels: 'numbered' });
  assert.match(html, /^<!doctype html>\n<html lang="en">/);
  for (const tag of ['main', 'figure', 'figcaption', 'svg', 'table', 'thead', 'tbody']) assert.ok(html.includes(`<${tag}`), tag);
  assert.ok(html.includes(`<title>${escapeXml(hostile)}</title>`));
  assert.ok(html.includes(`data-element-id="${escapeXml(hostile)}"`));
  assert.match(html, /role="region"[^>]*tabindex="0"/);
  assert.match(html, /overflow:auto/);
  assert.match(html, /<th scope="col">What<\/th>/);
  assert.doesNotMatch(html, /<script|<img\b|<object\b|<iframe\b|<link\b|<button\b|<input\b|\son\w+=|@import|@font-face|url\(/i);
  const all = ids(html);
  assert.equal(new Set(all).size, all.length);
  for (const id of all) assert.match(id, /^[A-Za-z][A-Za-z0-9_-]*$/);
  assert.equal(html, await renderHtml(spec, { labels: 'numbered' }));
});

test('structured SVG preserves geometry and default SVG stays opt-in', async () => {
  for (const name of ['container', 'change-impact', 'code', 'dynamic']) {
    const spec = JSON.parse(readFileSync(new URL(`../examples/diagrams/${name}.json`, import.meta.url), 'utf8')) as DiagramSpec;
    const plain = await render(spec, { theme: 'light' });
    const structured = await render(spec, { theme: 'light', structured: true });
    assert.deepEqual(geometry(structured.svg), geometry(plain.svg), name);
    assert.deepEqual([structured.width, structured.height, structured.report], [plain.width, plain.height, plain.report]);
    assert.doesNotMatch(plain.svg, /data-element-id|data-relationship-id|data-layer/);
    assert.equal((await render(spec, { theme: 'light', structured: false })).svg, plain.svg);
    assert.match(structured.svg, /id="dg-layer-elements" data-layer="elements"/);
    assert.match(structured.svg, /id="dg-layer-relationships" data-layer="relationships"/);
    assert.match(structured.svg, /data-type="[a-z]+" data-status="[a-z]+"/);
    assert.equal(new Set(ids(structured.svg)).size, ids(structured.svg).length);
    if (name === 'code') {
      assert.match(structured.svg, /data-path="services\/payments\/src\/authorise.rs"/);
      assert.match(structured.svg, /data-symbol-name="authorise" data-status="changed"/);
      assert.match(structured.svg, /data-to-symbol="/);
    }
  }
  assert.throws(() => renderHtmlDocument(base(), { structured: false } as Awaited<ReturnType<typeof render>>), /structured SVG/);
});

test('edge body, label, and legend share identity, including duplicate relationships', async () => {
  const spec = base();
  spec.relationships.push({ ...spec.relationships[0]! });
  const html = await renderHtml(spec, { labels: 'numbered' });
  const [a, b] = relationshipIds(spec);
  assert.notEqual(a, b);
  for (const id of [a, b]) {
    assert.equal([...html.matchAll(new RegExp(`data-relationship-id="${id}"`, 'g'))].length, 3);
    assert.ok(html.includes(`id="${id}"`));
    assert.ok(html.includes(`id="${id}-label"`));
  }
  assert.equal(new Set(ids(html)).size, ids(html).length);
  const other = { from: 'api', to: 'web', label: 'Returns orders' };
  assert.deepEqual(relationshipIds({ ...spec, relationships: [other, ...spec.relationships] }).slice(1), [a, b]);
  assert.deepEqual(relationshipIds({ ...spec, relationships: [...spec.relationships, other] }).slice(0, 2), [a, b]);
  // Repeated object references are also legal for library callers.
  spec.relationships[1] = spec.relationships[0]!;
  const repeated = await renderHtml(spec, { labels: 'numbered' });
  assert.equal(new Set(ids(repeated)).size, ids(repeated).length);
});

test('HTML themes match the selected palette and SVG styles stay scoped', async () => {
  for (const theme of ['light', 'dark', 'auto'] as const) {
    const html = await renderHtml(base(), { theme, palette: 'ebony', background: 'transparent' });
    assert.ok(html.includes(`color-scheme:${theme === 'auto' ? 'light dark' : theme}`));
    assert.match(html, /#dg-svg text\{font-family:/);
    assert.match(html, /#dg-svg \.bg\{fill:none;stroke:none\}/);
    assert.doesNotMatch(html, /(?:\}|<style>)text\{/);
    assert.equal(html.includes('prefers-color-scheme:dark'), theme === 'auto');
    assert.equal(html.includes('var(--fg)'), theme === 'auto');
  }
  assert.doesNotMatch(await renderHtml(base(), { labels: 'text' }), /<table>/);
});

test('diagram routes HTML files, stdin, stdout, reports, split themes, and PNG without parsing HTML', () => {
  const dir = mkdtempSync(join(tmpdir(), 'diagram-html-'));
  const path = join(dir, 'orders.json');
  writeFileSync(path, JSON.stringify(base()));
  const automatic = cli(path, '--format', 'html');
  assert.equal(automatic.status, 0, automatic.stderr);
  assert.equal(automatic.stdout.trim(), join(dir, 'orders.html'));
  assert.match(readFileSync(join(dir, 'orders.html'), 'utf8'), /^<!doctype html>/);
  const stdout = cli(path, '--format', 'html', '-o', '-');
  assert.equal(stdout.status, 0, stdout.stderr);
  assert.match(stdout.stdout, /^<!doctype html>/);
  const stdin = spawnSync(process.execPath, [fileURLToPath(new URL('./diagram-run.ts', import.meta.url)), '-', '--format', 'html'], { encoding: 'utf8', input: JSON.stringify(base()) });
  assert.equal(stdin.status, 0, stdin.stderr);
  assert.match(stdin.stdout, /^<!doctype html>/);
  const reported = cli(path, '--format', 'html', '-o', join(dir, 'reported.html'), '--png', join(dir, 'preview.png'), '--report');
  assert.equal(reported.status, 0, reported.stderr);
  const report = JSON.parse(reported.stdout);
  assert.deepEqual([report.format, report.output, report.html, report.svg], ['html', join(dir, 'reported.html'), join(dir, 'reported.html'), undefined]);
  assert.equal(readFileSync(join(dir, 'preview.png')).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const split = cli(path, '--format', 'html', '-o', join(dir, 'split.html'), '--theme', 'split');
  assert.equal(split.status, 0, split.stderr);
  for (const theme of ['light', 'dark']) {
    const file = join(dir, `split.${theme}.html`);
    assert.ok(split.stdout.includes(file));
    assert.match(readFileSync(file, 'utf8'), new RegExp(`color-scheme:${theme}`));
  }
  const lint = cli(path, '--format', 'html', '-o', join(dir, 'lint.html'), '--lint-only');
  assert.equal(lint.status, 0, lint.stderr);
  assert.equal(lint.stdout, '');
  assert.equal(existsSync(join(dir, 'lint.html')), false);
});

test('diagram rejects incompatible HTML output flags before writing files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'diagram-html-conflicts-'));
  const spec = join(dir, 'orders.json');
  const target = join(dir, 'orders.html');
  writeFileSync(spec, JSON.stringify(base()));
  for (const [args, message] of [
    [['--format', 'pdf'], /--format must be svg or html/],
    [['--format', 'html', '--mermaid'], /do not combine it with --mermaid/],
    [['--format', 'html', '--report'], /--report prints JSON/],
    [['--format', 'html', '--theme', 'split'], /--theme split needs/],
    [['--format', 'html', '--png', target], /same file/],
    [['--format', 'html', '--lint-only', '--png', join(dir, 'preview.png')], /draws nothing/],
  ] as const) {
    // --report needs an explicit stdout target because a file argument otherwise has a valid default path.
    const extra = args.some((arg) => arg === '--report') ? ['-o', '-'] : [];
    const out = cli(spec, ...args, ...extra);
    assert.equal(out.status, 2, out.stderr);
    assert.match(out.stderr, message);
    assert.equal(existsSync(target), false);
  }
});
