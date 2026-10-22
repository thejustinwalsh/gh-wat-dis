import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { CONFIG_REL, PKG, repoRoot } from '../cli/util.ts';
import type { DisItem, ItemRef } from './types.ts';

export type StampInput = ItemRef & { kind: 'issue' | 'pr'; updatedAt: string; baseSha?: string; headSha?: string };
export type Pass = 'quick' | 'full';
export type DiagramFormat = 'svg' | 'html';
export type Artifact = 'html' | 'markdown' | 'source' | 'spec' | 'svg' | 'png' | 'facts' | 'attachment';
export interface DisStamp extends StampInput {
  schema: 1;
  version: string;
  madeAt: string;
  mode: Pass;
  path: 'body' | 'generated';
  diagramSource?: string;
  format?: DiagramFormat;
  localMap?: { path: string; digest: string };
  warnings: string[];
  digests: Record<string, string>;
  files: Partial<Record<Artifact, string>> & { markdown: string; source: string };
}
export interface Bundle { stamp: DisStamp; directory: string; paths: Record<string, string>; markdown: string; publicationReused?: boolean }

/** Every existing component must be an ordinary directory, never a symlink into another tree. */
function directories(path: string): void {
  const parent = dirname(path);
  if (parent !== path) directories(parent);
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`cannot use cache directory "${path}": it is not an ordinary directory`);
}

export function cacheDirectory(item: ItemRef, cwd: string): string {
  const parts = item.repo.split('/');
  if (parts.length !== 2 || parts.some((p) => !/^[\w.-]+$/.test(p) || p === '.' || p === '..') || !Number.isSafeInteger(item.number) || item.number < 1) throw new Error('cannot cache an invalid repository or item number');
  const directory = join(realpathSync(resolve(repoRoot(cwd))), '.agents/gh-wat-dis/dis', ...parts, String(item.number));
  directories(directory);
  return directory;
}

export const stampInput = (item: StampInput): StampInput => ({ repo: item.repo, number: item.number, url: item.url, kind: item.kind, updatedAt: item.updatedAt, ...(item.baseSha ? { baseSha: item.baseSha } : {}), ...(item.headSha ? { headSha: item.headSha } : {}) });
const allowed = new Set(['explain.md', 'source.json', 'spec.json', 'diagram.svg', 'diagram.html', 'diagram.png', 'facts.json', 'attachment.jpg', 'attachment.gif', 'attachment.webp']);
const digest = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
const regular = (file: string): boolean => { try { const s = lstatSync(file); return s.isFile() && !s.isSymbolicLink() && s.size > 0; } catch { return false; } };

export function drift(old: StampInput & { madeAt: string }, item: StampInput): string[] {
  const out: string[] = [];
  if (old.repo !== item.repo || old.number !== item.number || old.url !== item.url || old.kind !== item.kind) out.push(`the cached source identity changed since ${old.madeAt}`);
  if (old.updatedAt !== item.updatedAt) out.push(`the item was updated from ${old.updatedAt} to ${item.updatedAt} since ${old.madeAt}`);
  for (const [field, label] of [['baseSha', 'base'], ['headSha', 'head']] as const) if (old[field] !== item[field]) out.push(`${label} moved from ${old[field]?.slice(0, 7) ?? 'none'} to ${item[field]?.slice(0, 7) ?? 'none'} since ${old.madeAt}`);
  return out;
}

/** A cache hit requires the stamp and every declared artifact; a partial directory is never a hit. */
export function readCache(item: StampInput, cwd: string, mode: Pass, format: DiagramFormat | 'any' = 'svg'): { bundle?: Bundle; drift: string[] } {
  const directory = cacheDirectory(item, cwd), file = join(directory, 'dis.json');
  if (!existsSync(directory)) return { drift: [] };
  const invalid = (): { drift: string[] } => ({ drift: ['the cached bundle is incomplete or uses another format; rebuilding it'] });
  if (!regular(file)) return invalid();
  let stamp: DisStamp;
  try { stamp = JSON.parse(readFileSync(file, 'utf8')) as DisStamp; } catch { return invalid(); }
  if (!stamp || typeof stamp !== 'object' || typeof stamp.repo !== 'string' || !Number.isSafeInteger(stamp.number) || typeof stamp.url !== 'string' || !['issue', 'pr'].includes(stamp.kind) || typeof stamp.updatedAt !== 'string' || stamp.baseSha !== undefined && typeof stamp.baseSha !== 'string' || stamp.headSha !== undefined && typeof stamp.headSha !== 'string') return invalid();
  if (stamp.schema !== 1 || stamp.version !== PKG.version || !['quick', 'full'].includes(stamp.mode) || !['body', 'generated'].includes(stamp.path) || typeof stamp.madeAt !== 'string' || !Number.isFinite(Date.parse(stamp.madeAt)) || !Array.isArray(stamp.warnings) || !stamp.warnings.every((w) => typeof w === 'string') || stamp.diagramSource !== undefined && typeof stamp.diagramSource !== 'string' || !stamp.digests || !stamp.files || stamp.files.markdown !== 'explain.md' || stamp.files.source !== 'source.json') return invalid();
  if (stamp.format !== undefined && !['svg', 'html'].includes(stamp.format)) return invalid();
  if (format !== 'any' && (stamp.format ?? 'svg') !== format) return { drift: ['the requested diagram output format changed; rebuilding it'] };
  if (Object.values(stamp.files).some((name) => typeof name !== 'string' || !allowed.has(name) || !regular(join(directory, name)))) return invalid();
  if (Object.values(stamp.files).some((name) => stamp.digests[name] !== digest(join(directory, name)))) return invalid();
  const changed = drift(stamp, item);
  const map = join(realpathSync(repoRoot(cwd)), CONFIG_REL);
  if (stamp.diagramSource?.startsWith(map) && !stamp.localMap) return invalid();
  if (stamp.localMap) {
    if (stamp.localMap.path !== map || typeof stamp.localMap.digest !== 'string') return invalid();
    if (!regular(map) || digest(map) !== stamp.localMap.digest) changed.push(`the local architecture map changed since ${stamp.madeAt}`);
  }
  if (changed.length) return { drift: changed };
  if (mode === 'full' && stamp.mode !== 'full') return { drift: [] };
  const paths = Object.fromEntries(Object.entries(stamp.files).map(([key, name]) => [key, join(directory, name)]));
  return { drift: [], bundle: { stamp, directory, paths: { ...paths, stamp: file }, markdown: readFileSync(paths.markdown!, 'utf8') } };
}

/** Serialize the brief publication step across processes. Building and network reads do not hold this lock. */
async function publicationLock(path: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    try { mkdirSync(path); return; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await setTimeout(20);
    }
  }
  throw new Error(`another dis build is publishing this item; retry after removing an abandoned lock at "${path}"`);
}

/** Build a complete sibling first. A failed build leaves the prior cache intact. */
export async function writeBundle(item: DisItem, cwd: string, mode: Pass, build: (stage: string) => Promise<Omit<DisStamp, keyof StampInput | 'schema' | 'version' | 'madeAt' | 'mode' | 'digests'>>): Promise<Bundle> {
  const directory = cacheDirectory(item, cwd), parent = dirname(directory);
  mkdirSync(parent, { recursive: true });
  const stage = join(parent, `.${item.number}-stage-${randomUUID()}`), backup = join(parent, `.${item.number}-previous-${randomUUID()}`);
  mkdirSync(stage);
  const lock = join(parent, `.${item.number}-publish.lock`);
  let backed = false, published = false, locked = false;
  try {
    const result = await build(stage);
    const stamp: DisStamp = { ...stampInput(item), schema: 1, version: PKG.version, madeAt: new Date().toISOString(), mode, digests: {}, ...result };
    if (Object.values(stamp.files).some((name) => !allowed.has(name) || !regular(join(stage, name)))) throw new Error('cannot publish an incomplete dis bundle');
    stamp.digests = Object.fromEntries(Object.values(stamp.files).map((name) => [name, digest(join(stage, name))]));
    writeFileSync(join(stage, 'dis.json'), JSON.stringify(stamp, null, 2) + '\n');
    await publicationLock(lock); locked = true;
    // A quick read that waited on GitHub may have missed a full pass published in the meantime.
    if (mode === 'quick') { const full = readCache(item, cwd, 'full', 'any').bundle; if (full) return { ...full, publicationReused: true }; }
    directories(directory);
    if (existsSync(directory)) { renameSync(directory, backup); backed = true; }
    try { renameSync(stage, directory); published = true; } catch (error) { if (backed) { renameSync(backup, directory); backed = false; } throw error; }
    const paths = Object.fromEntries(Object.entries(stamp.files).map(([key, name]) => [key, join(directory, name)]));
    return { stamp, directory, paths: { ...paths, stamp: join(directory, 'dis.json') }, markdown: readFileSync(paths.markdown!, 'utf8') };
  } finally {
    rmSync(stage, { recursive: true, force: true });
    if (published && backed) rmSync(backup, { recursive: true, force: true });
    if (locked) rmSync(lock, { recursive: true, force: true });
  }
}
