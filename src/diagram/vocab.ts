import type { SpecElement, Status } from '../spec.ts';

export const TYPE_LABEL: Record<string, string> = {
  person: 'Person', system: 'Software System', container: 'Container', component: 'Component',
  datastore: 'Data Store', queue: 'Queue', boundary: 'Boundary', node: 'Deployment Node',
};

export const STATUS_BADGE: Record<string, string> = {
  added: '+ ADDED', changed: '~ CHANGED', removed: '− REMOVED', affected: 'AFFECTED',
};

/** The mark that prefixes a relationship label, so status never rests on colour alone. */
export const STATUS_MARK: Record<string, string> = { added: '+', changed: '~', removed: '−', affected: '•' };

export type ActiveStatus = Exclude<Status, 'unchanged'>;
export const active = (s: Status | undefined): ActiveStatus | undefined => (s === 'unchanged' ? undefined : s);

export const kindLine = (el: SpecElement): string =>
  `[${el.external ? 'External ' : ''}${TYPE_LABEL[el.type] ?? el.type}${el.technology ? `: ${el.technology}` : ''}]`;
