import { ownersPatternToRegExp } from './glob.ts';
import type { OwnerMatch } from './types.ts';

export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

interface Rule { pattern: string; re: RegExp; owners: string[]; line: number }
export interface Codeowners { file: string; rules: Rule[] }

export function parseCodeowners(file: string, text: string): Codeowners {
  const rules: Rule[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) return;
    const [pattern, ...owners] = line.split(/\s+/);
    rules.push({ pattern: pattern!, re: ownersPatternToRegExp(pattern!), owners, line: i + 1 });
  });
  return { file, rules };
}

export function loadCodeowners(read: (path: string) => string | undefined): Codeowners | null {
  for (const file of CODEOWNERS_PATHS) {
    const text = read(file);
    if (text !== undefined) return parseCodeowners(file, text);
  }
  return null;
}

/** The last matching pattern wins. */
export function ownersOf(co: Codeowners | null, path: string): OwnerMatch {
  if (co) {
    for (let i = co.rules.length - 1; i >= 0; i--) {
      const r = co.rules[i]!;
      if (r.re.test(path)) return { path, owners: r.owners, rule: r.pattern, file: co.file, line: r.line, provenance: 'exact' };
    }
  }
  return { path, owners: [], rule: null, file: co?.file ?? null, provenance: 'exact' };
}
