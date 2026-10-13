// Codex runs commands in a sandbox that, by default, cannot write outside the project or reach the
// network. `npx` needs both: npm writes its cache and logs under ~/.npm on every run, and fetches the
// package on the first. With the cache blocked, npm does not fail: it allocates until the process
// runs out of memory. So every `npx gh-wat-dis` command dies before this package starts, and nothing
// here can report it from inside. This module reads Codex's config and offers the two settings.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export const CODEX_CONFIG = '.codex/config.toml';
const SECTION = 'sandbox_workspace_write';

export interface SandboxState {
  /** `workspace-write`, `read-only`, `danger-full-access`, or null when the config does not set it. */
  mode: string | null;
  writableRoots: string[];
  network: boolean;
  /** True when a command in the sandbox can write npm's cache. */
  cacheWritable: boolean;
}

export type Fix = 'both' | 'cache';

/** Where npm keeps its cache and logs: the `npm_config_cache` variable, else ~/.npm. */
export function npmCache(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return resolve(env.npm_config_cache ?? env.NPM_CONFIG_CACHE ?? join(home, '.npm'));
}

const unquote = (s: string): string => s.trim().replace(/^["']|["']$/g, '');
const expand = (p: string, home: string): string => resolve(p.startsWith('~') ? join(home, p.slice(1)) : p);
const inside = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** The lines of one `[section]`, without its header, and where they sit in the file. */
function section(lines: string[], name: string): { start: number; end: number } | null {
  const start = lines.findIndex((l) => l.trim() === `[${name}]`);
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  return { start, end };
}

/** Reads the three settings this module cares about. It is not a TOML parser: it reads `key = value` lines. */
export function readSandbox(text: string, cache: string, home: string = homedir()): SandboxState {
  const lines = text.split('\n');
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const top = lines.slice(0, firstTable < 0 ? lines.length : firstTable);
  const mode = top.map((l) => /^\s*sandbox_mode\s*=\s*(.+?)\s*(#.*)?$/.exec(l)?.[1]).find(Boolean);
  const sec = section(lines, SECTION);
  const body = sec ? lines.slice(sec.start + 1, sec.end).join('\n') : '';
  const roots = /^\s*writable_roots\s*=\s*\[([^\]]*)\]/m.exec(body)?.[1] ?? '';
  const writableRoots = roots.split(',').map(unquote).filter(Boolean);
  const network = /^\s*network_access\s*=\s*true\b/m.test(body);
  return {
    mode: mode ? unquote(mode) : null, writableRoots, network,
    cacheWritable: writableRoots.some((r) => inside(cache, expand(r, home))),
  };
}

/** True when the sandbox stops `npx`: it is on, and npm's cache is outside what it may write. */
export function blocksNpx(state: SandboxState): boolean {
  return state.mode !== 'danger-full-access' && !state.cacheWritable;
}

/**
 * The config text with the settings added, or null when the existing section is in a form this cannot
 * edit safely (an array over several lines). Nothing that is there is removed or rewritten.
 */
export function withFix(text: string, cache: string, fix: Fix, home: string = homedir()): string | null {
  const state = readSandbox(text, cache, home);
  const lines = text.split('\n');
  const sec = section(lines, SECTION);
  const root = `writable_roots = ["${cache}"]`;
  if (!sec) {
    const block = [`[${SECTION}]`, root, ...(fix === 'both' ? ['network_access = true'] : [])];
    return `${text.replace(/\n*$/, '')}\n\n${block.join('\n')}\n`;
  }
  const body = lines.slice(sec.start + 1, sec.end);
  const rootsAt = body.findIndex((l) => /^\s*writable_roots\s*=/.test(l));
  if (rootsAt >= 0 && !/\]\s*(#.*)?$/.test(body[rootsAt]!)) return null;
  if (!state.cacheWritable) {
    if (rootsAt < 0) body.unshift(root);
    else body[rootsAt] = body[rootsAt]!.replace(/\[\s*([^\]]*?)\s*\]/, (_m, inner: string) => `[${inner ? `${inner}, ` : ''}"${cache}"]`);
  }
  if (fix === 'both' && !state.network) {
    const netAt = body.findIndex((l) => /^\s*network_access\s*=/.test(l));
    if (netAt < 0) body.splice(body.findIndex((l) => /^\s*writable_roots\s*=/.test(l)) + 1, 0, 'network_access = true');
    else body[netAt] = 'network_access = true';
  }
  return [...lines.slice(0, sec.start + 1), ...body, ...lines.slice(sec.end)].join('\n');
}

export interface CodexSandbox { file: string; state: SandboxState; cache: string }

/** Codex's sandbox settings for this user, or null when Codex has no config here. */
export function codexSandbox(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): CodexSandbox | null {
  const file = join(home, CODEX_CONFIG);
  if (!existsSync(file)) return null;
  const cache = npmCache(env, home);
  return { file, state: readSandbox(readFileSync(file, 'utf8'), cache, home), cache };
}

/** The lines a person adds by hand, for the cases where the file is not written. */
export function fixLines(cache: string, fix: Fix): string {
  return [`[${SECTION}]`, `writable_roots = ["${cache}"]`, ...(fix === 'both' ? ['network_access = true'] : [])].join('\n');
}

/** Writes the settings into Codex's config. Returns what happened, for the caller to print. */
export function applyFix(fix: Fix, home: string = homedir(), env: NodeJS.ProcessEnv = process.env): { file: string; action: 'written' | 'unchanged' | 'manual' } | null {
  const found = codexSandbox(home, env);
  if (!found) return null;
  const before = readFileSync(found.file, 'utf8');
  const after = withFix(before, found.cache, fix, home);
  if (after === null) return { file: found.file, action: 'manual' };
  if (after === before) return { file: found.file, action: 'unchanged' };
  writeFileSync(found.file, after);
  return { file: found.file, action: 'written' };
}
