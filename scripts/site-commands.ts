// Writes the "See all commands" list in docs/index.html from the CLI's own tool list,
// the one `npx gh-wat-dis help` prints. Run: npm run site:commands.
// A test fails when the page and the CLI disagree.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../src/main.ts';

export const START = '<!-- commands:all -->';
export const END = '<!-- /commands:all -->';
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const WRITES = { reads: '', local: ' <i>writes local files</i>', github: ' <i>writes to GitHub</i>' };

/** The block between the two markers: one group of commands after another, as help groups them. */
export function allCommandsHtml(): string {
  const groups = [...new Set(TOOLS.map((t) => t.group))].flatMap((g) => [
    `      <h3>${esc(g)}</h3>`,
    '      <dl>',
    ...TOOLS.filter((t) => t.group === g).map((t) => `        <div><dt>${esc(t.name)}</dt><dd>${esc(t.description)}${WRITES[t.effect]}</dd></div>`),
    '      </dl>',
  ]);
  return [START, ...groups, `      ${END}`].join('\n');
}

export function withAllCommands(page: string): string {
  const a = page.indexOf(START);
  const b = page.indexOf(END);
  if (a < 0 || b < 0) throw new Error(`docs/index.html has no ${START} ... ${END} block`);
  return page.slice(0, a) + allCommandsHtml() + page.slice(b + END.length);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'index.html');
  writeFileSync(file, withAllCommands(readFileSync(file, 'utf8')));
  console.log(file);
}
