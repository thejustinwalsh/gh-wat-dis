import { DIAGRAM_TYPES, ELEMENT_TYPES, STATUSES } from '../spec.ts';
import type { LintResult } from '../spec.ts';

const WARN_ELEMENTS = 15;
const MAX_ELEMENTS = 40;
const MAX_DESCRIPTION = 120;
const FULL_DETAIL_MAX = 5;
const MAX_STEPS = 8;
const VAGUE = new Set(['uses', 'calls', 'depends on']);
const NEEDS_TECHNOLOGY = new Set(['container', 'component', 'datastore', 'queue']);
const CONTAINER_LIKE = new Set(['container', 'datastore', 'queue']);
const CONTEXT_TYPES = new Set(['person', 'system', 'boundary']);
const CODE_TYPES = new Set(['file', 'boundary']);
const MAX_SYMBOLS = 8;

type Bag = Record<string, unknown>;
const isBag = (v: unknown): v is Bag => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const oneOf = (list: readonly string[], v: unknown): boolean => typeof v === 'string' && list.includes(v);

/** Check a spec against C4 notation and the diagram review checklist. Errors stop a render, warnings do not. */
export function lintSpec(spec: unknown): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isBag(spec)) return { errors: ['spec must be a JSON object'], warnings };

  if (spec.title !== undefined && typeof spec.title !== 'string') errors.push('title must be text');
  else if (!text(spec.title)) errors.push('title is missing');
  if (!oneOf(DIAGRAM_TYPES, spec.type)) errors.push(`type must be one of ${DIAGRAM_TYPES.join(', ')}`);
  if (spec.direction !== undefined && spec.direction !== 'DOWN' && spec.direction !== 'RIGHT') {
    errors.push('direction must be DOWN or RIGHT');
  }
  if (!Array.isArray(spec.elements)) errors.push('elements must be an array');
  else if (!spec.elements.length) errors.push('elements is empty: there is nothing to draw');
  if (!Array.isArray(spec.relationships)) errors.push('relationships must be an array');
  // Without both lists the checks below would only report ids that "do not exist".
  if (!Array.isArray(spec.elements) || !Array.isArray(spec.relationships)) return { errors, warnings };
  // Descriptions are drawn up to 5 elements, or when asked for. Past that a missing one is not a fault.
  const parentIds = new Set(spec.elements.map((e) => (isBag(e) ? e.parent : undefined)));
  const leaves = spec.elements.filter((e) => isBag(e) && !parentIds.has(e.id) && e.type !== 'boundary' && e.type !== 'node').length;
  const described = spec.detail === 'full' || (spec.detail !== 'compact' && leaves <= FULL_DETAIL_MAX);
  const elements = Array.isArray(spec.elements) ? spec.elements : [];
  const relationships = Array.isArray(spec.relationships) ? spec.relationships : [];

  const byId = new Map<string, Bag>();
  elements.forEach((el: unknown, i) => {
    if (!isBag(el) || !text(el.id)) { errors.push(`elements[${i}] has no id`); return; }
    const id = el.id as string;
    if (byId.has(id)) errors.push(`element id "${id}" is used more than once`);
    byId.set(id, el);
    if (el.name !== undefined && typeof el.name !== 'string') errors.push(`element "${id}": name must be text`);
    else if (!text(el.name)) errors.push(`element "${id}" has no name`);
    if (!oneOf(ELEMENT_TYPES, el.type)) errors.push(`element "${id}" has unknown type "${String(el.type)}"`);
    if (el.status !== undefined && !oneOf(STATUSES, el.status)) {
      errors.push(`element "${id}" has unknown status "${String(el.status)}"`);
    }
    const type = String(el.type);
    if (NEEDS_TECHNOLOGY.has(type) && !text(el.technology)) warnings.push(`${type} "${id}" has no technology`);
    const description = text(el.description);
    if (!description && described && type !== 'boundary' && type !== 'node' && type !== 'file') warnings.push(`element "${id}" has no description`);
    if (description.length > MAX_DESCRIPTION) {
      warnings.push(`element "${id}" description is ${description.length} characters; keep it under ${MAX_DESCRIPTION}`);
    }
    if (spec.type === 'context' && oneOf(ELEMENT_TYPES, type) && !CONTEXT_TYPES.has(type)) {
      warnings.push(`context diagrams show people and systems; "${id}" is a ${type}`);
    }
    if (spec.type === 'code' && oneOf(ELEMENT_TYPES, type) && !CODE_TYPES.has(type)) {
      warnings.push(`code diagrams show files, grouped by boundaries; "${id}" is a ${type}`);
    }
    if (type === 'file' && spec.type !== 'code' && oneOf(DIAGRAM_TYPES, spec.type)) {
      warnings.push(`"${id}" is a file, which belongs in a code diagram; this is a ${String(spec.type)} diagram`);
    }
    if (el.symbols === undefined) return;
    if (!Array.isArray(el.symbols)) { errors.push(`element "${id}": symbols must be an array`); return; }
    if (type !== 'file') warnings.push(`element "${id}" has symbols, which only a file draws`);
    const names = new Set<string>();
    el.symbols.forEach((sym: unknown, k) => {
      if (!isBag(sym) || !text(sym.name)) { errors.push(`element "${id}": symbols[${k}] has no name`); return; }
      if (names.has(sym.name as string)) errors.push(`element "${id}" lists the symbol "${sym.name as string}" more than once`);
      names.add(sym.name as string);
      if (sym.status !== undefined && !oneOf(STATUSES, sym.status)) errors.push(`element "${id}": symbol "${sym.name as string}" has unknown status "${String(sym.status)}"`);
    });
    if (el.symbols.length > MAX_SYMBOLS) {
      warnings.push(`file "${id}" lists ${el.symbols.length} symbols and draws the first ${MAX_SYMBOLS}; keep the ones the change is about`);
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

  const orders = new Set<number>();
  if (spec.type === 'dynamic' && relationships.length > MAX_STEPS) {
    warnings.push(`a flow of ${relationships.length} steps is more than ${MAX_STEPS}; write the steps as a numbered list, or draw two flows`);
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
    if (!dangling && rel.from !== rel.to) {
      for (const [inner, outer] of [[rel.from, rel.to], [rel.to, rel.from]] as const) {
        for (let p = byId.get(inner as string)!.parent, n = 0; typeof p === 'string' && byId.has(p) && n < 50; p = byId.get(p)!.parent, n++) {
          if (p === outer) warnings.push(`${where} joins a group to an element inside it, which draws as a stub on the border of the group; relate the elements inside, or leave it out`);
        }
      }
    }
    const label = text(rel.label);
    const isFile = (end: unknown): boolean => typeof end === 'string' && byId.get(end)?.type === 'file';
    for (const [end, key] of [['from', 'fromSymbol'], ['to', 'toSymbol']] as const) {
      if (rel[key] === undefined || dangling) continue;
      const symbols = byId.get(rel[end] as string)!.symbols;
      if (!Array.isArray(symbols) || !symbols.some((sym) => isBag(sym) && sym.name === rel[key])) {
        errors.push(`${where}: ${key} "${String(rel[key])}" is not a symbol of "${String(rel[end])}"`);
      }
    }
    // A line between two files with no words is an import.
    if (!label && isFile(rel.from) && isFile(rel.to)) return;
    if (!label) errors.push(`${where} has no label; say what flows or why`);
    else if (VAGUE.has(label.toLowerCase())) errors.push(`${where} label "${label}" says nothing; name the data or intent`);
    if (rel.status !== undefined && !oneOf(STATUSES, rel.status)) {
      errors.push(`${where} has unknown status "${String(rel.status)}"`);
    }
    if (rel.order !== undefined && !(typeof rel.order === 'number' && Number.isInteger(rel.order) && rel.order >= 1 && rel.order <= 999)) {
      errors.push(`${where}: order must be a whole number from 1 to 999, got ${JSON.stringify(rel.order)}`);
    } else if (typeof rel.order === 'number') {
      if (orders.has(rel.order)) errors.push(`${where}: order ${rel.order} is used more than once`);
      orders.add(rel.order);
    }
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
