import type { Sym } from './model.ts';
import type { SymbolChangeKind } from './types.ts';

export interface SymbolChange {
  name: string;
  kind: string;
  exported: boolean;
  change: SymbolChangeKind;
  signatureChanged: boolean;
  before?: string;
  after?: string;
  container?: string;
}

const MAX_SIGNATURE = 400;
const clip = (s: string): string => (s.length > MAX_SIGNATURE ? `${s.slice(0, MAX_SIGNATURE - 1)}…` : s);

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
    if (!x || !y) {
      if (s.exported) out.push({ ...common, exported: true, change: y ? 'added' : 'removed', signatureChanged: false, ...(y ? { after: clip(y.header) } : { before: clip(x!.header) }) });
    } else if (x.exported !== y.exported) {
      out.push({ ...common, exported: true, change: y.exported ? 'added' : 'removed', signatureChanged: false, ...(y.exported ? { after: clip(y.header) } : { before: clip(x.header) }) });
    } else if (x.text !== y.text) {
      const signatureChanged = x.header !== y.header;
      out.push({ ...common, exported: y.exported, change: 'modified', signatureChanged, ...(signatureChanged ? { before: clip(x.header), after: clip(y.header) } : {}) });
    }
  }
  return out;
}
