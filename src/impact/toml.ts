export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable { [key: string]: TomlValue }

const isTable = (v: TomlValue | undefined): v is TomlTable => typeof v === 'object' && v !== null && !Array.isArray(v);

function splitKey(key: string): string[] {
  return (key.match(/"[^"]*"|'[^']*'|[^.\s]+/g) ?? []).map((k) => k.replace(/^["']|["']$/g, ''));
}

function descend(root: TomlTable, keys: string[]): TomlTable {
  let t = root;
  for (const k of keys) {
    const next = t[k];
    if (Array.isArray(next) && isTable(next[next.length - 1])) t = next[next.length - 1] as TomlTable;
    else if (isTable(next)) t = next;
    else t = t[k] = {};
  }
  return t;
}

class Reader {
  src: string;
  i = 0;
  constructor(src: string) { this.src = src; }
  ws(newlines: boolean): void {
    for (;;) {
      const c = this.src[this.i];
      if (c === ' ' || c === '\t' || c === '\r' || (newlines && c === '\n')) this.i++;
      else if (c === '#' && newlines) { while (this.i < this.src.length && this.src[this.i] !== '\n') this.i++; } else return;
    }
  }
  value(): TomlValue {
    const s = this.src;
    const c = s[this.i];
    if (c === '"' || c === "'") {
      const triple = s.startsWith(c.repeat(3), this.i);
      const q = triple ? c.repeat(3) : c;
      let j = this.i + q.length;
      let out = '';
      while (j < s.length && !s.startsWith(q, j)) {
        if (c === '"' && s[j] === '\\') { out += s[j + 1] === 'n' ? '\n' : s[j + 1]; j += 2; } else out += s[j++];
      }
      this.i = j + q.length;
      return out;
    }
    if (c === '[') {
      this.i++;
      const arr: TomlValue[] = [];
      for (;;) {
        this.ws(true);
        if (this.i >= s.length || s[this.i] === ']') { this.i++; return arr; }
        arr.push(this.value());
        this.ws(true);
        if (s[this.i] === ',') this.i++;
      }
    }
    if (c === '{') {
      this.i++;
      const table: TomlTable = {};
      for (;;) {
        this.ws(true);
        if (this.i >= s.length || s[this.i] === '}') { this.i++; return table; }
        const m = /^[^=]+/.exec(s.slice(this.i));
        if (!m) return table;
        this.i += m[0].length + 1;
        this.ws(false);
        const keys = splitKey(m[0].trim());
        descend(table, keys.slice(0, -1))[keys[keys.length - 1]!] = this.value();
        this.ws(true);
        if (s[this.i] === ',') this.i++;
      }
    }
    const m = /^[^\s,\]}#]+/.exec(s.slice(this.i));
    const raw = m?.[0] ?? '';
    this.i += Math.max(raw.length, 1);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    const n = Number(raw.replace(/_/g, ''));
    return raw !== '' && !Number.isNaN(n) ? n : raw;
  }
}

/** A tolerant reader for the TOML that Cargo manifests use. Not a full TOML parser. */
export function parseToml(src: string): TomlTable {
  const root: TomlTable = {};
  let table = root;
  const r = new Reader(src);
  while (r.i < src.length) {
    r.ws(true);
    if (r.i >= src.length) break;
    const lineEnd = src.indexOf('\n', r.i) < 0 ? src.length : src.indexOf('\n', r.i);
    const line = src.slice(r.i, lineEnd);
    const header = /^(\[\[?)\s*([^\]]+?)\s*\]\]?/.exec(line);
    if (header) {
      const keys = splitKey(header[2]!);
      if (header[1] === '[[') {
        const parent = descend(root, keys.slice(0, -1));
        const last = keys[keys.length - 1]!;
        const arr = Array.isArray(parent[last]) ? (parent[last] as TomlValue[]) : (parent[last] = []);
        table = {};
        arr.push(table);
      } else table = descend(root, keys);
      r.i = lineEnd;
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) { r.i = lineEnd; continue; }
    const keys = splitKey(line.slice(0, eq).trim());
    r.i += eq + 1;
    r.ws(false);
    if (keys.length) descend(table, keys.slice(0, -1))[keys[keys.length - 1]!] = r.value();
  }
  return root;
}

export const tomlTable = (v: TomlValue | undefined): TomlTable => (isTable(v) ? v : {});
