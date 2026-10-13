// Writes the "See all skills" list in docs/index.html from the skills' own descriptions.
// Run: npm run site:skills. A test fails when the page and the skills disagree.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillList } from '../src/cli/install.ts';

export const START = '<!-- skills:all -->';
export const END = '<!-- /skills:all -->';
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The block between the two markers. */
export function allSkillsHtml(): string {
  const rows = skillList().map((s) => `        <div><dt>${esc(s.name)}</dt><dd>${esc(s.does)}</dd></div>`);
  return [START, '      <dl>', ...rows, '      </dl>', `      ${END}`].join('\n');
}

export function withAllSkills(page: string): string {
  const a = page.indexOf(START);
  const b = page.indexOf(END);
  if (a < 0 || b < 0) throw new Error(`docs/index.html has no ${START} ... ${END} block`);
  return page.slice(0, a) + allSkillsHtml() + page.slice(b + END.length);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'index.html');
  writeFileSync(file, withAllSkills(readFileSync(file, 'utf8')));
  console.log(file);
}
