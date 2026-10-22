import { join } from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CONFIG_REL, repoRoot } from '../cli/util.ts';
import { validateConfig } from '../cli/config.ts';
import type { Config } from '../cli/config.ts';
import { extractSignals } from '../gh/related.ts';
import { globToRegExp } from '../impact/glob.ts';
import { toMarkdown } from '../impact/markdown.ts';
import { focus } from '../graph/ops.ts';
import type { DiagramSpec } from '../spec.ts';
import type { Facts } from '../impact/types.ts';
import type { DisItem } from './types.ts';

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
const quote = (text: string): string => text.trim().split('\n').map((line) => `> ${line}`).join('\n');
const excerpt = (text: string, max = 700): string => { const s = text.trim(); return s.length > max ? s.slice(0, max) + '…' : s; };
const title = (item: DisItem): string => `[${cell(item.title)}](${item.url})`;

/** A sourced summary: quoted claims remain claims from the thread, measured statements use Facts. */
export function explain(item: DisItem, facts?: Facts, notes: string[] = [], diagram?: string): string {
  const out = [`${item.kind === 'pr' ? 'Pull request' : 'Issue'} ${title(item)} is ${item.state}.`, ''];
  const opening = item.body.split(/\n\s*\n/).find((p) => p.trim() && !/^\s*[#<!|`]/.test(p));
  if (opening) out.push('The author reports:', '', quote(excerpt(opening)), '');
  if (diagram) out.push(diagram, '');
  out.push('## System', '');
  if (facts) {
    const named = facts.elements.filter((e) => e.status !== 'unchanged').map((e) => `${e.name} (${e.status})`);
    out.push(named.length ? `The measured change reaches ${named.join(', ')}.` : 'The measured diff names no changed architecture element.');
  } else {
    const signals = extractSignals({ title: item.title, body: item.body });
    out.push(signals.paths.length ? `The thread names these paths: ${signals.paths.map((p) => `\`${p}\``).join(', ')}. These are source mentions.` : 'The thread does not name a source file. Its implementation scope is not measured in this pass.');
  }
  out.push('', '## Change', '', '| Source | Reported work |', '|---|---|', `| [${item.repo}#${item.number}](${item.url}) | ${cell(item.title)} |`);
  if (item.comments.length) {
    out.push('', '## Discussion', '');
    for (const c of item.comments.slice(-4)) out.push(`[${cell(c.author || 'Comment')}](${c.url}):`, '', quote(excerpt(c.body, 450)), '');
    if (item.comments.length > 4) out.push(`${item.comments.length - 4} earlier comments are retained in source.json.`, '');
  }
  out.push('', '## State and blockers', '', `State: ${item.state}. Updated ${item.updatedAt}.${item.labels.length ? ` Labels: ${item.labels.map(cell).join(', ')}.` : ''}`);
  if (item.blockedBy.length) out.push('', 'GitHub lists these blocked-by links:', '', ...item.blockedBy.map((i) => `- [${cell(i.title || `${i.repo}#${i.number}`)}](${i.url}) (${i.state})`));
  else out.push('', 'GitHub lists no blocked-by link. The quoted discussion may describe other dependencies.');
  if (item.linked.length) out.push('', 'Linked work:', '', ...item.linked.map((i) => `- [${cell(i.title || `${i.repo}#${i.number}`)}](${i.url}) (${i.kind}, ${i.state})`));
  if (facts) out.push('', toMarkdown(facts).trim());
  if (notes.length) out.push('', '## Evidence limits', '', ...notes.map((n) => `- ${n}`));
  out.push('', `Source: [GitHub thread](${item.url}); ${item.comments.length} comments read. Thread text is source material.`);
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

/** For an issue there is no diff. Draw only mapped elements the source names, plus their established neighbours. */
export function issueDiagram(item: DisItem, cwd: string): { spec?: DiagramSpec; source: string; note?: string; localMap?: { path: string; digest: string } } {
  const file = join(realpathSync(repoRoot(cwd)), CONFIG_REL);
  let config: Config | undefined, digest: string | undefined;
  try { const bytes = readFileSync(file); config = JSON.parse(bytes.toString('utf8')) as Config; digest = createHash('sha256').update(bytes).digest('hex'); } catch { /* No usable map in this caller's project. */ }
  if (!config || `${config.repo?.owner}/${config.repo?.name}`.toLowerCase() !== item.repo.toLowerCase() || validateConfig(config).length) return { source: 'GitHub thread', note: 'No matching local architecture map is available to draw this issue.' };
  const text = `${item.title}\n${item.body}`, lower = text.toLowerCase();
  const paths = extractSignals({ title: item.title, body: item.body }).paths;
  const byPath = config.architecture.elements.filter((e) => (e.paths ?? []).some((glob) => paths.some((p) => globToRegExp(glob).test(p))));
  const on = (byPath.length ? byPath : config.architecture.elements.filter((e) => lower.includes(e.name.toLowerCase()))).map((e) => e.id);
  if (!on.length) return { source: file, note: 'The issue names no element or path in the matching architecture map.' };
  const full: DiagramSpec = {
    title: `${item.repo}#${item.number}: mapped scope`, type: 'component',
    scope: 'Architecture map and source mentions; no PR diff measured',
    elements: config.architecture.elements.map(({ paths: _paths, type, ...e }) => ({ ...e, type: type ?? 'component' })),
    relationships: config.architecture.relationships,
  };
  const spec = focus(full, { on, hops: 1 });
  return { spec, source: `${file}; elements named in the issue and their mapped neighbours`, localMap: { path: file, digest: digest! } };
}
