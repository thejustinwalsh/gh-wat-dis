import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const PKG: { name: string; version: string; homepage: string } =
  JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
export const CONFIG_REL = '.agents/gh-wat-dis/config.json';
export const TMP_DIR = '.wat-tmp';

/** A command: takes its arguments, returns the exit code. */
export type Command = (argv: string[]) => Promise<number>;

export class UsageError extends Error {}

export type Parsed<B extends string, S extends string> =
  { _: string[] } & { [K in B]?: true } & { [K in S]?: string };

export function parseArgs<const B extends string = never, const S extends string = never>(
  argv: string[],
  spec: { booleans?: readonly B[]; strings?: readonly S[]; aliases?: Record<string, string> } = {},
): Parsed<B, S> {
  const booleans: readonly string[] = spec.booleans ?? [];
  const strings: readonly string[] = spec.strings ?? [];
  const positional: string[] = [];
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = spec.aliases?.[argv[i]!] ?? argv[i]!;
    if (a === '-' || !a.startsWith('--')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    const key = a.slice(2, eq < 0 ? undefined : eq);
    if (booleans.includes(key)) out[key] = true;
    else if (strings.includes(key)) {
      const value = eq < 0 ? argv[++i] : a.slice(eq + 1);
      if (value === undefined) throw new UsageError(`option --${key} needs a value`);
      out[key] = value;
    } else throw new UsageError(`unknown option --${key}`);
  }
  return { ...out, _: positional } as Parsed<B, S>;
}

export function run(cmd: string, args: string[], opts: { cwd?: string } = {}): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
  } catch {
    return null;
  }
}

export function repoRoot(cwd: string = process.cwd()): string {
  const top = run('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (top) return top;
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json')) || existsSync(join(dir, 'Cargo.toml'))) return dir;
    if (dir === dirname(dir)) return resolve(cwd);
  }
}

export function readJson<T = unknown>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; }
}

/** Read a file argument, or stdin for "-" or for no argument when stdin is piped. */
export function readInput(file: string | undefined): string {
  if (file && file !== '-') return readFileSync(file, 'utf8');
  if (!file && process.stdin.isTTY) throw new UsageError('no input: pass a file, or pipe data to stdin');
  return readFileSync(0, 'utf8');
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
