import type { DiagramSpec } from '../spec.ts';
import { relNumber } from './layout.ts';
import { STATUS_MARK, active, relText } from './vocab.ts';

/** Text from a spec goes into Markdown as text: a pipe would end the cell, and a tag would be HTML on GitHub. */
const cell = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** The relationships of a spec as a Markdown table. With numbered lines, this carries the words. */
export function toLegend(spec: DiagramSpec): string {
  const name = new Map(spec.elements.map((e) => [e.id, e.name]));
  const anyStatus = spec.relationships.some((r) => active(r.status));
  const rows = [...spec.relationships]
    .sort((a, b) => relNumber(spec, a) - relNumber(spec, b))
    .map((r) => {
      const status = active(r.status);
      const cols = [
        String(relNumber(spec, r)),
        cell(name.get(r.from) ?? r.from),
        cell(name.get(r.to) ?? r.to),
        cell(relText(r)),
        r.technology ? `\`${cell(r.technology)}\`` : '',
        ...(anyStatus ? [status ? `${STATUS_MARK[status]} ${status}` : ''] : []),
      ];
      return `| ${cols.join(' | ')} |`;
    });
  const head = ['#', 'From', 'To', 'What', 'How', ...(anyStatus ? ['Change'] : [])];
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows, ''].join('\n');
}
