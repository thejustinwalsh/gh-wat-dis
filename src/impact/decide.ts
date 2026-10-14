// Whether a change needs a diagram, decided from the facts. A diagram is the default for a change to source: it is
// left out only when it would add nothing, and each such case is named from the facts in `skip`.
import type { DiagramDecision, ElementFact, Facts, FileKind, PartFact, Provenance } from './types.ts';

/** One function whose cognitive complexity rose by this much is hard to follow from the diff. */
export const ONE_RISE = 15;
/** The listed functions together gaining this much is hard to follow from the diff. */
export const TOTAL_RISE = 40;

const ORDER: Provenance[] = ['exact', 'resolved', 'measured', 'heuristic'];
const weakest = (xs: Provenance[]): Provenance => xs.reduce<Provenance>((w, p) => (ORDER.indexOf(p) > ORDER.indexOf(w) ? p : w), 'exact');
const TEXT: FileKind[] = ['docs', 'other', 'generated'];
const CODE: FileKind[] = ['source', 'test', 'schema', 'migration'];

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const list = (xs: string[]): string => (xs.length > 3 ? `${xs.slice(0, 3).join(', ')} and ${xs.length - 3} more` : xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs.join(''));
const KIND_WORDS: Record<PartFact['kind'], string> = { command: 'command', tool: 'tool', skill: 'skill', route: 'route', job: 'scheduled job', bin: 'bin entry', export: 'exports entry', option: 'option' };

/** The command that draws the diagram the decision names. */
export function drawCommand(level: DiagramDecision['level'], facts = 'facts.json'): string {
  if (level === 'dynamic') return 'write a dynamic spec by hand (wat-diagram skill), then npx gh-wat-dis diagram dynamic.json -o .wat-tmp/flow.svg';
  return `npx gh-wat-dis graph from-facts ${facts}${level === 'code' ? ' --level file' : ''} | npx gh-wat-dis diagram - -o .wat-tmp/${level === 'code' ? 'code' : 'change'}.svg`;
}

/** The decision in one line, for the top of `blast` and for `lint`. */
export function decisionLine(d: DiagramDecision): string {
  return d.draw ? `draw ${d.level === 'element' ? 'an' : 'a'} ${d.level} diagram: ${d.reasons.join('; ')}` : `no diagram: ${d.skip}`;
}

export function decideDiagram(facts: Facts): DiagramDecision {
  const byId = new Map(facts.elements.map((e) => [e.id, e]));
  const name = (id: string): string => byId.get(id)?.name ?? id;
  const files = facts.files;
  const reasons: string[] = [];
  const basis: Provenance[] = [];
  const skip = (why: string, ...from: Provenance[]): DiagramDecision => ({ draw: false, level: null, reasons: [], skip: why, provenance: weakest(from.length ? from : ['exact']) });
  if (!files.length) return skip('nothing changed');

  // Structure: an element or a relationship that comes or goes. A folder that only stands in for an element counts
  // when it holds code: a new folder of notes is not a new part of the system.
  const coded = new Set(files.filter((f) => f.language !== null || CODE.includes(f.kind)).map((f) => f.element));
  const real = (e: ElementFact): boolean => e.source !== 'git' || coded.has(e.id);
  for (const e of facts.elements.filter((x) => (x.status === 'added' || x.status === 'removed') && real(x))) {
    reasons.push(`${e.status === 'added' ? 'adds' : 'removes'} the element ${e.name}`);
    basis.push(e.provenance);
  }
  for (const e of facts.edges.filter((x) => x.status === 'added' || x.status === 'removed')) {
    reasons.push(`${e.status === 'added' ? 'adds' : 'removes'} the relationship ${name(e.from)} → ${name(e.to)}`);
    basis.push(e.provenance);
  }
  const parts = facts.parts ?? [];
  for (const p of parts.filter((x) => x.kind !== 'option')) {
    reasons.push(`${p.change === 'added' ? 'adds' : 'removes'} the ${p.name} ${KIND_WORDS[p.kind]} in ${name(p.element)}`);
    basis.push(p.provenance);
  }
  // A part is a box of its own in an element diagram. An option is not: it changes what a command takes, and the
  // diagram that shows it is the code inside the command.
  const structural = reasons.length > 0;
  const options = new Map<string, PartFact[]>();
  for (const p of parts.filter((x) => x.kind === 'option')) {
    const cut = p.name.lastIndexOf(' --');
    const k = `${p.change}\0${cut > 0 ? p.name.slice(0, cut) : ''}\0${p.element}`;
    options.set(k, [...(options.get(k) ?? []), p]);
  }
  for (const [k, ps] of options) {
    const [change, command, element] = k.split('\0') as [string, string, string];
    const flags = ps.map((p) => p.name.slice(p.name.lastIndexOf(' ') + 1));
    reasons.push(`${change === 'added' ? 'adds' : 'removes'} the ${list(flags)} ${flags.length === 1 ? 'option' : 'options'}${command ? ` of ${command}` : ''} in ${name(element)}`);
    basis.push(...ps.map((p) => p.provenance));
  }

  const kinds = new Set(files.map((f) => f.kind));
  const codeFiles = files.filter((f) => CODE.includes(f.kind));
  if (!structural && !codeFiles.length) {
    const rest = [...kinds].filter((k) => !TEXT.includes(k));
    if (!rest.length) return skip('only text and documentation changed');
    if (rest.every((k) => k === 'lockfile' || k === 'manifest')) return skip(`only dependency and version changes (${list(files.filter((f) => f.kind === 'lockfile' || f.kind === 'manifest').map((f) => f.path))})`);
    return skip(`only ${[...new Set(rest.map((k) => (k === 'ci' ? 'CI' : k === 'lockfile' || k === 'manifest' ? 'dependency' : 'config')))].join(', ')} and text files changed, and no relationship changed`);
  }
  if (!structural && codeFiles.every((f) => f.kind === 'test')) return skip('only tests changed');

  // Contracts: the shape of data that crosses a boundary.
  for (const c of facts.contracts.filter((x) => x.kind !== 'package-entry')) { reasons.push(`changes the ${c.kind} contract in ${c.path}`); basis.push(c.provenance); }

  const source = files.filter((f) => f.kind === 'source');
  const moved = facts.symbols.filter((s) => !s.renamedFrom);
  const renamesOnly = source.length > 0 && source.every((f) => f.status === 'renamed' && f.insertions + f.deletions === 0)
    || (facts.symbols.length > 0 && !moved.length && source.every((f) => f.status !== 'added' && f.status !== 'deleted'));
  if (!reasons.length && renamesOnly) return skip('only renames', 'resolved');
  if (!reasons.length && source.length && !facts.symbols.length && source.every((f) => f.language && !f.skipped && f.status === 'modified')) {
    return skip('no declaration changed outside comments and layout', 'resolved');
  }

  // Logic: how far the functions moved.
  const rise = (f: Facts['complexity'][number]): number => (f.after?.cognitive ?? 0) - (f.before?.cognitive ?? 0);
  const rises = facts.complexity.filter((f) => f.change !== 'removed').map((f) => ({ f, r: rise(f) })).sort((a, b) => b.r - a.r);
  const total = rises.reduce((n, x) => n + Math.max(0, x.r), 0);
  const hard = rises.filter((x) => x.r >= ONE_RISE);
  if (hard.length || total >= TOTAL_RISE) {
    const top = (hard.length ? hard : rises.slice(0, 3)).map((x) => `${x.f.name} (${x.f.file})`);
    reasons.push(`the logic of ${list(top)} changed more than a sentence can carry`);
    basis.push('measured');
  }
  const outside = new Set(files.map((f) => f.path));
  for (const s of facts.symbols.filter((x) => x.exported && x.signatureChanged)) {
    const users = s.dependents.filter((d) => !d.inDiff && !/(^|\/)(tests?|__tests__)\/|\.(test|spec)\./.test(d.file) && !outside.has(d.file));
    if (users.length) { reasons.push(`changes the signature of ${s.name}, which ${plural(users.length, 'file')} outside the diff ${users.length === 1 ? 'imports' : 'import'}`); basis.push(s.provenance); }
  }
  const steps = facts.symbols.filter((s) => s.callsReordered);
  if (steps.length) { reasons.push(`reorders the calls in ${list(steps.map((s) => s.name))}`); basis.push('heuristic'); }

  const measured = facts.summary.complexity !== undefined;
  const added = moved.some((s) => s.change !== 'modified');
  if (!reasons.length && measured && facts.complexity.length === 0 && !added && !facts.summary.exportedSignatureChanges) {
    return skip('no function gained or lost a branch, no declaration was added or removed, and no relationship changed', 'measured', 'resolved');
  }
  if (!reasons.length) {
    // The elements the product code is in. Tests that come with it are not an element of their own here.
    const els = [...new Set(codeFiles.filter((f) => f.kind !== 'test').map((f) => f.element))];
    reasons.push(`changes code in ${plural(els.length, 'element')}: ${list(els.map(name))}`);
    basis.push('exact');
  }

  const parsed = files.some((f) => f.language && (f.kind === 'source' || f.kind === 'test') && !f.skipped);
  const level: DiagramDecision['level'] = structural || !parsed ? 'element' : steps.length && !hard.length ? 'dynamic' : 'code';
  return { draw: true, level, reasons, skip: null, provenance: weakest(basis) };
}
