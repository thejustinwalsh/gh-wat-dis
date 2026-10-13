import { DIAGRAM_TYPES, ELEMENT_TYPES, STATUSES } from '../spec.ts';
import type { LintResult } from '../spec.ts';

const WARN_ELEMENTS = 15;
const MAX_ELEMENTS = 40;
const MAX_DESCRIPTION = 120;
const VAGUE = new Set(['uses', 'calls', 'depends on']);
const NEEDS_TECHNOLOGY = new Set(['container', 'component', 'datastore', 'queue']);
const CONTAINER_LIKE = new Set(['container', 'datastore', 'queue']);
const CONTEXT_TYPES = new Set(['person', 'system', 'boundary']);

type Bag = Record<string, unknown>;
const isBag = (v: unknown): v is Bag => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const oneOf = (list: readonly string[], v: unknown): boolean => typeof v === 'string' && list.includes(v);

/** Check a spec against C4 notation and the diagram review checklist. Errors stop a render, warnings do not. */
export function lintSpec(spec: unknown): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isBag(spec)) return { errors: ['spec must be a JSON object'], warnings };

  if (!text(spec.title)) errors.push('title is missing');
  if (!oneOf(DIAGRAM_TYPES, spec.type)) errors.push(`type must be one of ${DIAGRAM_TYPES.join(', ')}`);
  if (spec.direction !== undefined && spec.direction !== 'DOWN' && spec.direction !== 'RIGHT') {
    errors.push('direction must be DOWN or RIGHT');
  }
  if (!Array.isArray(spec.elements)) errors.push('elements must be an array');
  if (!Array.isArray(spec.relationships)) errors.push('relationships must be an array');
  const elements = Array.isArray(spec.elements) ? spec.elements : [];
  const relationships = Array.isArray(spec.relationships) ? spec.relationships : [];

  const byId = new Map<string, Bag>();
  elements.forEach((el: unknown, i) => {
    if (!isBag(el) || !text(el.id)) { errors.push(`elements[${i}] has no id`); return; }
    const id = el.id as string;
    if (byId.has(id)) errors.push(`element id "${id}" is used more than once`);
    byId.set(id, el);
    if (!text(el.name)) errors.push(`element "${id}" has no name`);
    if (!oneOf(ELEMENT_TYPES, el.type)) errors.push(`element "${id}" has unknown type "${String(el.type)}"`);
    if (el.status !== undefined && !oneOf(STATUSES, el.status)) {
      errors.push(`element "${id}" has unknown status "${String(el.status)}"`);
    }
    const type = String(el.type);
    if (NEEDS_TECHNOLOGY.has(type) && !text(el.technology)) warnings.push(`${type} "${id}" has no technology`);
    const description = text(el.description);
    if (!description && type !== 'boundary' && type !== 'node') warnings.push(`element "${id}" has no description`);
    if (description.length > MAX_DESCRIPTION) {
      warnings.push(`element "${id}" description is ${description.length} characters; keep it under ${MAX_DESCRIPTION}`);
    }
    if (spec.type === 'context' && oneOf(ELEMENT_TYPES, type) && !CONTEXT_TYPES.has(type)) {
      warnings.push(`context diagrams show people and systems; "${id}" is a ${type}`);
    }
  });

  for (const [id, el] of byId) {
    if (el.parent === undefined) continue;
    if (typeof el.parent !== 'string' || !byId.has(el.parent)) {
      errors.push(`element "${id}" has parent "${String(el.parent)}", which does not exist`);
      continue;
    }
    const seen = new Set([id]);
    for (let p: unknown = el.parent; typeof p === 'string' && byId.has(p); p = byId.get(p)!.parent) {
      if (seen.has(p)) { errors.push(`element "${id}" is in a parent cycle`); break; }
      seen.add(p);
    }
  }

  relationships.forEach((rel: unknown, i) => {
    if (!isBag(rel)) { errors.push(`relationships[${i}] is not an object`); return; }
    const where = `relationship ${String(rel.from)} -> ${String(rel.to)}`;
    let dangling = false;
    for (const end of ['from', 'to'] as const) {
      if (typeof rel[end] !== 'string' || !byId.has(rel[end])) {
        errors.push(`${where}: ${end} "${String(rel[end])}" does not exist`);
        dangling = true;
      }
    }
    const label = text(rel.label);
    if (!label) errors.push(`${where} has no label; say what flows or why`);
    else if (VAGUE.has(label.toLowerCase())) errors.push(`${where} label "${label}" says nothing; name the data or intent`);
    if (rel.status !== undefined && !oneOf(STATUSES, rel.status)) {
      errors.push(`${where} has unknown status "${String(rel.status)}"`);
    }
    if (rel.order !== undefined && typeof rel.order !== 'number') errors.push(`${where}: order must be a number`);
    if (!dangling && !text(rel.technology)
      && CONTAINER_LIKE.has(String(byId.get(rel.from as string)!.type))
      && CONTAINER_LIKE.has(String(byId.get(rel.to as string)!.type))) {
      warnings.push(`${where} has no technology; name the protocol between containers`);
    }
  });

  if (elements.length > MAX_ELEMENTS) {
    errors.push(`${elements.length} elements is more than ${MAX_ELEMENTS}; split the diagram or focus it with \`graph focus\``);
  } else if (elements.length > WARN_ELEMENTS) {
    warnings.push(`${elements.length} elements is more than ${WARN_ELEMENTS}; split the diagram or focus it with \`graph focus\``);
  }
  return { errors, warnings };
}
