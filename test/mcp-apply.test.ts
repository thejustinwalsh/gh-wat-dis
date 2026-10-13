import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyClient } from '../src/cli/mcp-apply.ts';

const home = (): string => mkdtempSync(join(tmpdir(), 'wat-home-'));

test('apply: adds the entry and keeps what the file already holds', () => {
  const h = home();
  mkdirSync(join(h, '.cursor'));
  writeFileSync(join(h, '.cursor/mcp.json'), JSON.stringify({ mcpServers: { other: { url: 'x' } }, keep: 1 }));
  const res = applyClient('cursor', { scope: 'user', home: h });
  assert.equal(res.action, 'added');
  const doc = JSON.parse(readFileSync(join(h, '.cursor/mcp.json'), 'utf8'));
  assert.equal(doc.keep, 1);
  assert.deepEqual(Object.keys(doc.mcpServers), ['other', 'github']);
  assert.equal(doc.mcpServers.github.headers.Authorization, 'Bearer ${env:GITHUB_PERSONAL_ACCESS_TOKEN}');
  assert.equal(doc.mcpServers.github.headers['X-MCP-Readonly'], 'true');
  assert.equal(applyClient('cursor', { scope: 'user', home: h }).action, 'exists');
});

test('apply: never writes a token value, only a variable name', () => {
  const h = home();
  for (const c of ['cursor', 'gemini', 'opencode', 'codex']) applyClient(c, { scope: 'user', home: h });
  const files = ['.cursor/mcp.json', '.gemini/settings.json', '.config/opencode/opencode.json', '.codex/config.toml'].map((f) => readFileSync(join(h, f), 'utf8'));
  for (const text of files) {
    assert.match(text, /GITHUB_PERSONAL_ACCESS_TOKEN/);
    assert.doesNotMatch(text, /gh[opsu]_[A-Za-z0-9]{20,}|github_pat_/);
  }
  assert.match(files[3]!, /^\[mcp_servers\.github\]\nurl = "https:\/\/api\.githubcopilot\.com\/mcp\/"\nbearer_token_env_var = "GITHUB_PERSONAL_ACCESS_TOKEN"/m);
});

test('apply: appends to a Codex config and does not repeat itself', () => {
  const h = home();
  mkdirSync(join(h, '.codex'));
  writeFileSync(join(h, '.codex/config.toml'), 'model = "x"\n');
  assert.equal(applyClient('codex', { scope: 'user', home: h }).action, 'added');
  assert.equal(applyClient('codex', { scope: 'user', home: h }).action, 'exists');
  const text = readFileSync(join(h, '.codex/config.toml'), 'utf8');
  assert.ok(text.startsWith('model = "x"\n\n[mcp_servers.github]'));
  assert.equal(text.match(/\[mcp_servers\.github\]/g)?.length, 1);
});

test('apply: refuses a config it cannot parse and leaves it alone', () => {
  const h = home();
  mkdirSync(join(h, '.config/opencode'), { recursive: true });
  const original = '{\n  // my notes\n  "mcp": {}\n}\n';
  writeFileSync(join(h, '.config/opencode/opencode.json'), original);
  const res = applyClient('opencode', { scope: 'user', home: h });
  assert.equal(res.action, 'failed');
  assert.match(res.detail ?? '', /npx gh-wat-dis mcp opencode/);
  assert.equal(readFileSync(join(h, '.config/opencode/opencode.json'), 'utf8'), original);
});

test('apply: dry run and unknown harness change nothing', () => {
  const h = home();
  assert.equal(applyClient('gemini', { scope: 'user', home: h, dryRun: true }).action, 'added');
  assert.throws(() => readFileSync(join(h, '.gemini/settings.json')));
  assert.equal(applyClient('windsurf', { scope: 'user', home: h }).action, 'skipped');
});
