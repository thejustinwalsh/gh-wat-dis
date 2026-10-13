import type { ElementFact, Facts, MarkdownOptions, Provenance, SymbolDependent } from './types.ts';

const LANGUAGE_NAMES: Record<string, string> = { typescript: 'TypeScript', javascript: 'JavaScript', rust: 'Rust' };
const ORDER: Provenance[] = ['exact', 'resolved', 'measured', 'heuristic'];
const ELEMENTS_SHOWN = 6;

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

  // The diff already shows the changed files. This section says what the diff does not:
  // which parts of the system the change sits in, and what outside the diff leans on it.
  const rank = { removed: 0, added: 1, changed: 2, affected: 3, unchanged: 4 };
  const els = facts.elements.filter((e) => e.status !== 'unchanged')
    .sort((a, b) => rank[a.status] - rank[b.status] || b.filesChanged - a.filesChanged || b.dependentsAffected - a.dependentsAffected || a.name.localeCompare(b.name));
  const named = (xs: ElementFact[], detail: (e: ElementFact) => string): string => {
    const shown = xs.slice(0, ELEMENTS_SHOWN).map((e) => `${e.name}${detail(e)}`);
    return [...shown, ...(xs.length > ELEMENTS_SHOWN ? [`+${xs.length - ELEMENTS_SHOWN} more`] : [])].join(', ');
  };
  // Elements from the architecture map come first. A directory fallback (tests, root files) is named as what it is.
  const mapped = (e: ElementFact): number => Number(e.source !== 'config');
  const touched = els.filter((e) => e.status !== 'affected').sort((a, b) => mapped(a) - mapped(b));
  const reached = els.filter((e) => e.status === 'affected');
  const where: string[] = [];
  // Only a repository with an architecture map has elements outside it. Without a map every element is a fallback.
  const hasMap = facts.elements.some((e) => e.source === 'config');
  const inMap = hasMap ? touched.filter((e) => e.source === 'config') : touched;
  const unmapped = hasMap ? touched.filter((e) => e.source !== 'config') : [];
  if (inMap.length) where.push(`Changes ${named(inMap, (e) => (e.status === 'changed' ? '' : ` (${e.status})`))}.`);
  if (unmapped.length) where.push(`${inMap.length ? 'Also changes' : 'Changes'} ${named(unmapped, () => '')}, which the architecture map does not name.`);
  if (reached.length) { where.push(`Reaches ${named(reached, (e) => ` (${plural(e.dependentsAffected, 'file')})`)}.`); labels.add('measured'); }
  els.forEach((e) => labels.add(e.provenance));
  if (where.length) out.push('', where.join(' '));
  if (facts.owners.length) out.push('', `Owners: ${facts.owners.map((o) => o.owner).join(' ')}`);

  const inDiff = new Set(facts.files.map((f) => f.path));
  const outside = facts.dependents.direct.filter((d) => !d.isTest && !inDiff.has(d.file))
    .sort((a, b) => b.symbols.length - a.symbols.length || b.imports.length - a.imports.length || a.file.localeCompare(b.file));
  outside.slice(0, max).forEach((d) => labels.add(d.provenance));
  out.push(...list('Depends on the changed code, not in this diff', outside.map((d) =>
    `${file(d.file)} · ${d.symbols.length ? `uses ${d.symbols.slice(0, 3).map(code).join(', ')}${d.symbols.length > 3 ? ` +${d.symbols.length - 3}` : ''}` : `imports ${d.imports.slice(0, 2).map(file).join(', ')}`}`), max));

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
  // One line for each file that is missing from the diff, with its strongest partner first.
  const byFile = new Map<string, typeof facts.coChange>();
  for (const c of facts.coChange) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);
  const together = [...byFile].map(([f, cs]) => [f, [...cs].sort((a, b) => b.commits - a.commits || b.ratio - a.ratio)] as const)
    .sort((a, b) => b[1][0]!.commits - a[1][0]!.commits || b[1][0]!.ratio - a[1][0]!.ratio || a[0].localeCompare(b[0]));
  out.push(
    ...list('Exported signatures changed', sig.map((x) => `${x.kind === 'method' ? `${code(x.name)}: ` : ''}${arrow(x.before ?? '', x.after ?? '')} (${file(x.file)})${deps(x.dependents)}`), max),
    ...movedLines,
    ...list('Contract surfaces touched', facts.contracts.map((c) => `${file(c.path)} · ${c.kind} · ${c.note}`), max),
    ...list('Tests that import the changed modules', facts.tests.importingChanged.map(file), max),
    ...list('Usually changes with these files, not in this diff', together.map(([f, cs]) => `${file(f)} with ${file(cs[0]!.withFile)}${cs.length > 1 ? ` and ${cs.length - 1} more` : ''} · ${plural(cs[0]!.commits, 'commit')} in 90 days (${Math.round(cs[0]!.ratio * 100)}%)`), max),
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
