import type { Sym } from './model.ts';
import type { SymbolChangeKind } from './types.ts';

export interface SymbolChange {
  name: string;
  kind: string;
  exported: boolean;
  change: SymbolChangeKind;
  signatureChanged: boolean;
  /** Lines of the declaration the change added or took away, comments and blank lines aside. */
  lines: number;
  before?: string;
  after?: string;
  container?: string;
  /** Set when the declaration is one the base had under this name: the same body, renamed. */
  renamedFrom?: string;
}

const MAX_SIGNATURE = 400;
const clip = (s: string): string => (s.length > MAX_SIGNATURE ? `${s.slice(0, MAX_SIGNATURE - 1)}…` : s);

/**
 * Source text with its comments taken out and its white space folded, so that a change to a
 * comment or to the layout of the code is not a change to the declaration. Strings are kept whole.
 */
export function code(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!, next = text[i + 1];
    if (ch === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (ch === '/' && next === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 1; out += ' '; continue; }
    if (ch === '"' || ch === '`' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch && (ch === '`' || text[j] !== '\n')) j += text[j] === '\\' ? 2 : 1;
      // A quote with no partner on its line is a Rust lifetime, not a string.
      if (text[j] !== ch) { out += ch; continue; }
      out += text.slice(i, j + 1);
      i = j;
      continue;
    }
    out += ch;
  }
  return out.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

/** Where the line breaks fall is layout, not code. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

/** Lines that are in one text and not in the other, counted both ways. */
function linesChanged(before: string, after: string): number {
  const a = before ? before.split('\n') : [], b = after ? after.split('\n') : [];
  const inA = new Set(a), inB = new Set(b);
  return a.filter((l) => !inB.has(l)).length + b.filter((l) => !inA.has(l)).length;
}

function byName(syms: Sym[]): Map<string, Sym> {
  const out = new Map<string, Sym>();
  for (const s of syms) {
    if (s.name === '*') { out.set(`* ${s.reexport?.spec ?? ''}`, s); continue; }
    const cur = out.get(s.name);
    if (!cur) out.set(s.name, { ...s });
    else { cur.header += `; ${s.header}`; cur.text += `\n${s.text}`; cur.exported ||= s.exported; }
  }
  return out;
}

/** A word on its own: the name as an identifier, not as part of a longer one. */
const word = (name: string): RegExp => new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`, 'g');

/**
 * A declaration that went away and one that came, of one kind, whose bodies match once the old name reads as the
 * new one, are one declaration renamed: a change of name, not a new function with all its complexity. A body that
 * changed as well still counts while at least half of its lines are the same: a rename often renames what the body mentions.
 */
function renames(changes: SymbolChange[], base: Map<string, Sym>, head: Map<string, Sym>): SymbolChange[] {
  const gone = changes.filter((c) => c.change === 'removed' && base.has(c.name));
  const used = new Set<SymbolChange>();
  const out: SymbolChange[] = [];
  for (const c of changes) {
    if (c.change !== 'added' || !head.has(c.name)) { out.push(c); continue; }
    const y = head.get(c.name)!;
    const after = code(y.text);
    let best: { old: SymbolChange; lines: number } | undefined;
    for (const old of gone) {
      if (used.has(old) || old.kind !== c.kind) continue;
      const x = base.get(old.name)!;
      const before = code(x.text).replace(word(old.name), c.name);
      const lines = linesChanged(before, after);
      // Lines that are in both texts, against the longer one. A rename often renames what the body mentions too.
      const size = Math.max(before.split('\n').length, after.split('\n').length);
      const same = (before.split('\n').length + after.split('\n').length - lines) / 2;
      if (same / size >= 0.5 && (!best || lines < best.lines)) best = { old, lines };
    }
    if (!best) { out.push(c); continue; }
    used.add(best.old);
    out.push({ name: c.name, kind: c.kind, ...(c.container ? { container: c.container } : {}), exported: c.exported, change: 'modified', signatureChanged: false, lines: best.lines, renamedFrom: best.old.name });
  }
  return out.filter((c) => !used.has(c));
}

/** Compare the declarations of one file on base and head. `null` means the file is absent on that side. */
export function diffSymbols(base: Sym[] | null, head: Sym[] | null): SymbolChange[] {
  const a = byName(base ?? []), b = byName(head ?? []);
  const out: SymbolChange[] = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(key), y = b.get(key);
    const s = (y ?? x)!;
    const name = s.name === '*' ? `* from ${s.reexport?.spec}` : s.name;
    const common = { name, kind: s.kind, ...(s.container ? { container: s.container } : {}) };
    const before = x ? code(x.text) : '', after = y ? code(y.text) : '';
    if (!x || !y) {
      // A private declaration that comes or goes is part of the change too: a moved helper, a new queue.
      out.push({ ...common, exported: s.exported, change: y ? 'added' : 'removed', signatureChanged: false, lines: linesChanged(before, after), ...(y ? { after: clip(y.header) } : { before: clip(x!.header) }) });
    } else if (x.exported !== y.exported) {
      out.push({ ...common, exported: true, change: y.exported ? 'added' : 'removed', signatureChanged: false, lines: linesChanged(before, after), ...(y.exported ? { after: clip(y.header) } : { before: clip(x.header) }) });
    } else if (flat(before) !== flat(after)) {
      const signatureChanged = flat(code(x.header)) !== flat(code(y.header));
      out.push({ ...common, exported: y.exported, change: 'modified', signatureChanged, lines: linesChanged(before, after), ...(signatureChanged ? { before: clip(x.header), after: clip(y.header) } : {}) });
    }
  }
  return renames(out, a, b);
}
