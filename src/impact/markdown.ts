import type { ElementFact, Facts, MarkdownOptions, Provenance, SymbolDependent } from './types.ts';

const LANGUAGE_NAMES: Record<string, string> = { typescript: 'TypeScript', javascript: 'JavaScript', rust: 'Rust' };
const ORDER: Provenance[] = ['exact', 'resolved', 'measured', 'heuristic'];
const TABLE_ROWS = 10;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const code = (s: string): string => (s.includes('`') ? `\`\` ${s} \`\`` : `\`${s}\``);
const SIGNATURE_WIDTH = 120;

/** Both sides cut to the same window, placed where they first differ. */
function window(before: string, after: string): [string, string] {
  if (before.length <= SIGNATURE_WIDTH && after.length <= SIGNATURE_WIDTH) return [before, after];
  let p = 0;
  while (p < before.length && before[p] === after[p]) p++;
  const start = p < SIGNATURE_WIDTH - 30 ? 0 : p - 30;
  const cut = (x: string): string => `${start ? '…' : ''}${x.slice(start, start + SIGNATURE_WIDTH)}${x.length > start + SIGNATURE_WIDTH ? '…' : ''}`;
  return [cut(before), cut(after)];
}
const arrow = (before: string, after: string): string => window(before, after).map(code).join(' → ');

function list(title: string, items: string[], max: number): string[] {
  if (!items.length) return [];
  const shown = items.slice(0, max).map((i) => `- ${i}`);
  if (items.length > max) shown.push(`- +${items.length - max} more`);
  return ['', `**${title}**`, ...shown];
}

/** A path as code, linked to the file at the commit when the facts name a repository and a commit. */
function linker(facts: Facts, on: boolean): (path: string) => string {
  const deleted = new Set(facts.files.filter((f) => f.status === 'deleted').map((f) => f.path));
  return (path) => {
    const sha = deleted.has(path) ? facts.base : facts.head;
    if (!on || !facts.repository || !/^[0-9a-f]{7,64}$/.test(sha)) return code(path);
    return `[${code(path)}](${facts.repository}/blob/${sha.slice(0, 12)}/${path.split('/').map(encodeURIComponent).join('/')})`;
  };
}

export function toMarkdown(facts: Facts, opts: MarkdownOptions = {}): string {
  const max = opts.maxItems ?? 5;
  const s = facts.summary;
  const labels = new Set<Provenance>();
  const file = linker(facts, opts.links !== false);
  const out: string[] = [];
  const heading = opts.heading === undefined ? '## Blast radius' : opts.heading;
  if (heading) out.push(heading, '');

  const parts = [`${plural(s.filesChanged, 'file')} changed in ${plural(s.elementsChanged, 'element')}`, plural(s.directDependents, 'direct dependent')];
  if (s.exportedSignatureChanges) parts.push(`${plural(s.exportedSignatureChanges, 'exported signature')} changed`);
  out.push(`**${parts.join(' · ')}**`);
  if (facts.files.length) labels.add('exact');

  const ownersOf = (e: ElementFact): string => {
    const changed = facts.files.filter((f) => f.element === e.id);
    const paths = new Set(changed.length ? changed.map((f) => f.path) : facts.dependents.direct.filter((d) => d.element === e.id).map((d) => d.file));
    const names = facts.owners.filter((o) => [...o.files, ...o.dependentFiles].some((p) => paths.has(p))).map((o) => o.owner);
    return names.length ? names.join(' ') : '–';
  };
  const rank = { removed: 0, added: 1, changed: 2, affected: 3, unchanged: 4 };
  const rows = facts.elements.filter((e) => e.status !== 'unchanged')
    .sort((a, b) => rank[a.status] - rank[b.status] || b.filesChanged - a.filesChanged || b.dependentsAffected - a.dependentsAffected || a.name.localeCompare(b.name));
  if (rows.length) {
    out.push('', '| Element | Change | Files | Dependents | Owners |', '|---|---|---|---|---|');
    for (const e of rows.slice(0, TABLE_ROWS)) {
      labels.add(e.provenance);
      if (e.dependentsAffected) labels.add('measured');
      out.push(`| ${e.name} | ${e.status} | ${e.filesChanged} of ${e.files} | ${e.dependentsAffected} | ${ownersOf(e)} |`);
    }
    if (rows.length > TABLE_ROWS) out.push('', `+${rows.length - TABLE_ROWS} more elements`);
  }

  const churn = (f: { insertions: number; deletions: number }): number => f.insertions + f.deletions;
  out.push(...list('Files changed', [...facts.files].sort((a, b) => churn(b) - churn(a) || a.path.localeCompare(b.path))
    .map((f) => `${file(f.path)} · ${f.binary ? 'binary' : `+${f.insertions} −${f.deletions}`}${f.status === 'modified' ? '' : ` · ${f.status}`}`), max));

  const exported = facts.symbols.filter((x) => x.exported);
  const deps = (d: SymbolDependent[]): string => {
    if (!d.length) return '';
    const inDiff = d.filter((x) => x.inDiff).length;
    return ` · ${plural(d.length, 'dependent')}${inDiff ? ` (${inDiff} in this diff)` : ''}`;
  };
  const newFiles = new Set(facts.files.filter((f) => f.status === 'added').map((f) => f.path));
  const note = (xs: { provenance: Provenance }[]): void => xs.forEach((x) => labels.add(x.provenance));
  const sig = exported.filter((x) => x.signatureChanged);
  const moved = exported.filter((x) => x.change !== 'modified' && !newFiles.has(x.file))
    .sort((a, b) => Number(b.change === 'removed') - Number(a.change === 'removed') || b.dependents.length - a.dependents.length);
  const inNew = exported.filter((x) => newFiles.has(x.file));
  note(sig.slice(0, max)); note(moved.slice(0, max)); note(inNew.slice(0, 1));
  for (const x of [...sig.slice(0, max), ...moved.slice(0, max)]) note(x.dependents);

  const movedLines = list('Exports added or removed', moved.map((x) => `${x.change} ${code(x.name)} (${file(x.file)})${deps(x.dependents)}`), max);
  if (inNew.length) {
    if (!movedLines.length) movedLines.push('', '**Exports added or removed**');
    movedLines.push(`- added ${plural(inNew.length, 'export')} in ${plural(new Set(inNew.map((x) => x.file)).size, 'new file')}`);
  }
  out.push(
    ...list('Exported signatures changed', sig.map((x) => `${x.kind === 'method' ? `${code(x.name)}: ` : ''}${arrow(x.before ?? '', x.after ?? '')} (${file(x.file)})${deps(x.dependents)}`), max),
    ...movedLines,
    ...list('Contract surfaces touched', facts.contracts.map((c) => `${file(c.path)} · ${c.kind} · ${c.note}`), max),
    ...list('Tests that import the changed modules', facts.tests.importingChanged.map(file), max),
    ...list('Changed together in the last 90 days, not in this diff', facts.coChange.map((c) => `${file(c.file)} with ${file(c.withFile)} · ${plural(c.commits, 'commit')} (${Math.round(c.ratio * 100)}%)`), max),
    ...list('Dependency changes', facts.dependencies.map((d) => `${d.change} ${code(d.name)}${d.from !== undefined || d.to !== undefined ? ` ${[d.from, d.to].filter((v) => v !== undefined).join(' → ')}` : ''} (${d.manifest})`), max),
  );
  note(facts.contracts.slice(0, max));
  if (facts.tests.importingChanged.length) note(facts.dependents.direct.filter((d) => d.isTest));
  if (facts.coChange.length) labels.add('measured');
  if (facts.dependencies.length) labels.add('exact');

  const sources = facts.tiers.ran.map((t) => (t === 'ast-grep' && facts.tiers.languages.length ? `ast-grep (${facts.tiers.languages.map((l) => LANGUAGE_NAMES[l] ?? l).join(', ')})` : t));
  const present = ORDER.filter((l) => labels.has(l));
  out.push('', `_Sources: ${sources.join(', ')}.${present.length ? ` Labels: ${present.join(', ')}.` : ''}_`);
  return `${out.join('\n')}\n`;
}
