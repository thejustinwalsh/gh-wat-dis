import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DIS_CACHE_REL = '.agents/gh-wat-dis/dis';
const IGNORE_REL = '.agents/gh-wat-dis/.gitignore';

/** Add only our cache rule, preserving the project's other ignore entries. */
export function ensureDisIgnore(root: string, dryRun = false): boolean {
  const file = join(root, IGNORE_REL);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (text.split(/\r?\n/).some((line) => line.trim() === 'dis/')) return false;
  if (!dryRun) {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}dis/\n`);
  }
  return true;
}
