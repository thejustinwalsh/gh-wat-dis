// What a change did to the complexity of each function: cccc's scores on base and on head, paired.
// The numbers are inputs for a decision (does this change need a diagram?), not a grade for the code.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { measure } from '../tools/cccc.ts';
import type { CcccFunction } from '../tools/cccc.ts';
import type { ComplexityFact, Score } from './types.ts';

/** A named function with the scores of the anonymous functions inside it added in. */
export interface Unit extends Score { name: string; kind: string; line: number }

export const TOP_LEVEL = '<top level>';

/**
 * cccc scores every function alone, callbacks included. A reader thinks in named functions, so an
 * anonymous function counts toward the nearest named one around it, or toward the file's top level.
 * A named function inside another stays its own unit, named `outer > inner`.
 */
export function units(functions: readonly CcccFunction[] | undefined): Unit[] {
  const out: Unit[] = [];
  const top: Unit = { name: TOP_LEVEL, kind: 'module', line: 1, cognitive: 0, cyclomatic: 1 };
  let topUsed = false;
  const walk = (list: readonly CcccFunction[], owner: Unit | null, path: string): void => {
    for (const f of list) {
      if (!f.name || f.name === '<anonymous>') {
        const into = owner ?? top;
        if (!owner) topUsed = true;
        into.cognitive += f.cognitive;
        into.cyclomatic += f.cyclomatic - 1;
        walk(f.children ?? [], into === top ? null : into, path);
        continue;
      }
      const name = path ? `${path} > ${f.name}` : f.name;
      const unit: Unit = { name, kind: f.kind, line: f.line, cognitive: f.cognitive, cyclomatic: f.cyclomatic };
      out.push(unit);
      walk(f.children ?? [], unit, name);
    }
  };
  walk(functions ?? [], null, '');
  if (topUsed) out.push(top);
  return out;
}

/** Pair by name and kind. Where a name repeats, the nearest first lines pair first. */
export function pair(base: readonly Unit[], head: readonly Unit[]): { base?: Unit; head?: Unit }[] {
  const key = (u: Unit): string => `${u.name}\0${u.kind}`;
  const byKey = new Map<string, Unit[]>();
  for (const b of base) byKey.set(key(b), [...(byKey.get(key(b)) ?? []), b]);
  const used = new Set<Unit>();
  const out: { base?: Unit; head?: Unit }[] = [];
  const candidates = head.flatMap((h) => (byKey.get(key(h)) ?? []).map((b) => ({ h, b, d: Math.abs(h.line - b.line) })))
    .sort((x, y) => x.d - y.d || x.h.line - y.h.line);
  for (const { h, b } of candidates) {
    if (used.has(h) || used.has(b)) continue;
    used.add(h); used.add(b);
    out.push({ base: b, head: h });
  }
  for (const h of head) if (!used.has(h)) out.push({ head: h });
  for (const b of base) if (!used.has(b)) out.push({ base: b });
  return out;
}

export interface Side { path: string; basePath: string; base?: string; head?: string }

const score = (u: Unit): Score => ({ cognitive: u.cognitive, cyclomatic: u.cyclomatic });
const trivial = (u: Unit): boolean => u.cognitive === 0 && u.cyclomatic <= 1;

/** Functions whose scores differ between base and head, plus added and removed ones that branch at all. */
export function complexityFacts(bin: string, sides: readonly Side[]): ComplexityFact[] {
  const tmp = mkdtempSync(join(tmpdir(), 'gh-wat-dis-cx-'));
  try {
    const run = (dir: string, files: [path: string, text: string][]): Map<string, Unit[]> => {
      const root = join(tmp, dir);
      for (const [path, text] of files) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
      if (!files.length) return new Map();
      return new Map(measure(bin, root, files.map(([p]) => p)).map((f) => [f.path.replace(/\\/g, '/').replace(/^\.\//, ''), units(f.functions)]));
    };
    const base = run('base', sides.filter((s) => s.base !== undefined).map((s) => [s.basePath, s.base!]));
    const head = run('head', sides.filter((s) => s.head !== undefined).map((s) => [s.path, s.head!]));
    const facts: ComplexityFact[] = [];
    for (const s of sides) {
      for (const p of pair(base.get(s.basePath) ?? [], head.get(s.path) ?? [])) {
        const u = (p.head ?? p.base)!;
        if (p.base && p.head) {
          if (p.base.cognitive === p.head.cognitive && p.base.cyclomatic === p.head.cyclomatic) continue;
        } else if (trivial(u)) continue;
        facts.push({
          file: s.path, name: u.name, kind: u.kind, line: u.line,
          change: p.base && p.head ? 'modified' : p.head ? 'added' : 'removed',
          ...(p.base ? { before: score(p.base) } : {}), ...(p.head ? { after: score(p.head) } : {}),
          provenance: 'measured', source: 'cccc',
        });
      }
    }
    const rise = (f: ComplexityFact): number => (f.after?.cognitive ?? 0) - (f.before?.cognitive ?? 0);
    return facts.sort((a, b) => Math.abs(rise(b)) - Math.abs(rise(a)) || a.file.localeCompare(b.file) || a.line - b.line);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
