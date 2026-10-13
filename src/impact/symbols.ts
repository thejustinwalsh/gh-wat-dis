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
  return out;
}
