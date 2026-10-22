import type { SpecElement, SpecRelationship, Status } from '../spec.ts';

export const TYPE_LABEL: Record<string, string> = {
  person: 'Person', system: 'Software System', container: 'Container', component: 'Component',
  datastore: 'Data Store', queue: 'Queue', boundary: 'Boundary', node: 'Deployment Node', file: 'File',
};

export const STATUS_BADGE: Record<string, string> = {
  added: '+ ADDED', changed: '~ CHANGED', removed: '− REMOVED', affected: 'AFFECTED',
};

/** The mark that prefixes a relationship label, so status never rests on colour alone. */
export const STATUS_MARK: Record<string, string> = { added: '+', changed: '~', removed: '−', affected: '•' };

export type ActiveStatus = Exclude<Status, 'unchanged'>;
// Renderers can be called without linting: only known statuses can become CSS classes or marks.
export const active = (s: Status | undefined): ActiveStatus | undefined =>
  s === 'added' || s === 'changed' || s === 'removed' || s === 'affected' ? s : undefined;

export const kindLine = (el: SpecElement): string =>
  `[${el.external ? 'External ' : ''}${el.kind?.trim() || (TYPE_LABEL[el.type] ?? el.type)}${el.technology ? `: ${el.technology}` : ''}]`;

/** One word for a status, as the key of a code diagram and a Mermaid node say it. */
export const STATUS_WORD: Record<string, string> = { added: 'Added', changed: 'Changed', removed: 'Removed', affected: 'Affected' };

/** What a relationship says in words. A line between two files with no label is an import. */
export const relText = (rel: SpecRelationship): string => rel.label?.trim() || (rel.toSymbol ? `Imports ${rel.toSymbol}` : 'Imports');
