import type { DiagramSpec, SpecElement } from '../spec.ts';
import { LIGHT } from './theme.ts';
import { STATUS_BADGE, STATUS_MARK, active, kindLine, relText } from './vocab.ts';

const quote = (s: string): string => s.replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;');
const SHAPE: Record<string, [string, string]> = { person: ['([', '])'], datastore: ['[(', ')]'], queue: ['[[', ']]'] };
const ARROW: Record<string, string> = { added: '==>', changed: '-.->', removed: '-.->' };

/** A plain flowchart with subgraphs. It uses only syntax GitHub's Mermaid renders. */
export function toMermaid(spec: DiagramSpec): string {
  const ids = new Map<string, string>();
  const taken = new Set<string>();
  for (const el of spec.elements) {
    let id = el.id.replace(/\W/g, '_');
    if (/^(end|graph|subgraph|flowchart|class|style|click|default)$/i.test(id) || /^\d/.test(id)) id = `n_${id}`;
    while (taken.has(id)) id += '_';
    taken.add(id);
    ids.set(el.id, id);
  }
  const children = new Map<string | undefined, SpecElement[]>();
  for (const el of spec.elements) {
    const key = el.parent !== undefined && ids.has(el.parent) ? el.parent : undefined;
    children.set(key, [...(children.get(key) ?? []), el]);
  }
  const out = [`flowchart ${spec.direction === 'RIGHT' ? 'LR' : 'TB'}`];
  const classes: string[] = [];
  const emit = (el: SpecElement, indent: string): void => {
    const id = ids.get(el.id)!;
    const status = active(el.status);
    const kids = children.get(el.id);
    if (status) classes.push(`  class ${id} ${status}`);
    if (kids) {
      out.push(`${indent}subgraph ${id}["${quote(el.name)}${spec.type === 'code' ? '' : ` ${quote(kindLine(el))}`}${status ? ` ${STATUS_BADGE[status]}` : ''}"]`);
      for (const kid of kids) emit(kid, indent + '  ');
      out.push(`${indent}end`);
      return;
    }
    const [open, close] = SHAPE[el.type] ?? ['[', ']'];
    // A file is its path, then one line for each symbol with its mark.
    const symbols = (el.symbols ?? []).map((s) => `${active(s.status) ? `${STATUS_MARK[active(s.status)!]} ` : ''}${s.name}`);
    const lines = el.type === 'file'
      ? [status ? STATUS_BADGE[status]! : '', el.name, ...symbols, el.description ?? ''].filter(Boolean)
      : [status ? STATUS_BADGE[status]! : '', el.name, kindLine(el), el.description ?? ''].filter(Boolean);
    out.push(`${indent}${id}${open}"${lines.map(quote).join('<br/>')}"${close}`);
  };
  for (const el of children.get(undefined) ?? []) emit(el, '  ');
  for (const rel of spec.relationships) {
    const from = ids.get(rel.from), to = ids.get(rel.to);
    if (!from || !to) continue;
    const status = active(rel.status);
    const label = [
      status ? `${STATUS_BADGE[status]}: ` : '',
      rel.order !== undefined ? `${rel.order}. ` : '',
      relText(rel),
      rel.technology ? ` [${rel.technology}]` : '',
    ].join('');
    out.push(`  ${from} ${ARROW[status ?? ''] ?? '-->'}|"${quote(label)}"| ${to}`);
  }
  for (const status of ['added', 'changed', 'removed', 'affected'] as const) {
    if (!classes.some((c) => c.endsWith(` ${status}`))) continue;
    const dash = status === 'changed' ? ',stroke-dasharray:8 4' : status === 'removed' ? ',stroke-dasharray:2 4' : '';
    out.push(`  classDef ${status} stroke:${LIGHT[status]},stroke-width:3px${dash}`);
  }
  return [...out, ...classes].join('\n') + '\n';
}
