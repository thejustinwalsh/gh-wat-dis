import { DETAILS, DIAGRAM_TYPES, ELEMENT_TYPES, LABEL_MODES, STATUSES } from '../spec.ts';
import type { DiagramSpec, LintResult } from '../spec.ts';
import { GROUP_NAME_BUDGET, LABEL_BUDGET, over, trim } from './budget.ts';

const MAX_ELEMENTS = 40;
const MAX_DESCRIPTION = 120;
const FULL_DETAIL_MAX = 5;
const MAX_STEPS = 8;
const MAX_SYMBOLS = 8;
const MAX_NAME = 120;
/** An element of one of these types may hold others. A person, a store, a queue or a file may not. */
const HOLDERS = new Set(['boundary', 'node', 'system', 'container', 'component']);
const SPEC_KEYS = new Set(['title', 'type', 'scope', 'direction', 'detail', 'labels', 'elements', 'relationships']);
const ELEMENT_KEYS = new Set(['id', 'type', 'name', 'kind', 'technology', 'description', 'parent', 'external', 'status', 'symbols', 'meta']);
const RELATIONSHIP_KEYS = new Set(['from', 'to', 'label', 'technology', 'status', 'order', 'fromSymbol', 'toSymbol', 'meta']);
/** `key` holds text when it is there. */
const textField = (bag: Bag, key: string): boolean => bag[key] === undefined || typeof bag[key] === 'string';
const VAGUE = new Set(['uses', 'calls', 'depends on']);
const NEEDS_TECHNOLOGY = new Set(['container', 'component', 'datastore', 'queue']);
const CONTAINER_LIKE = new Set(['container', 'datastore', 'queue']);
const CONTEXT_TYPES = new Set(['person', 'system', 'boundary']);
const CODE_TYPES = new Set(['file', 'boundary']);

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
  if (spec.detail !== undefined && !oneOf(DETAILS, spec.detail)) errors.push(`detail must be one of ${DETAILS.join(', ')}`);
  if (spec.labels !== undefined && !oneOf(LABEL_MODES, spec.labels)) errors.push(`labels must be one of ${LABEL_MODES.join(', ')}`);
  if (!textField(spec, 'scope')) errors.push('scope must be text');
  // A key the renderer does not read is most often a misspelt one, and would be ignored in silence.
  const unknown = (bag: Bag, known: Set<string>, where: string): void => {
    for (const key of Object.keys(bag)) if (!known.has(key)) warnings.push(`${where} has the key "${key}", which the renderer does not read`);
  };
  unknown(spec, SPEC_KEYS, 'the spec');
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
  // After an element with a bad id, a relationship to it would only repeat the fault as "does not exist".
  let badIds = false;
  elements.forEach((el: unknown, i) => {
    if (!isBag(el) || typeof el.id !== 'string' || !text(el.id)) { errors.push(isBag(el) && el.id !== undefined && typeof el.id !== 'string' ? `elements[${i}]: id must be text` : `elements[${i}] has no id`); badIds = true; return; }
    unknown(el, ELEMENT_KEYS, `element "${el.id}"`);
    for (const key of ['kind', 'technology', 'description']) if (!textField(el, key)) errors.push(`element "${el.id}": ${key} must be text`);
    if (el.external !== undefined && typeof el.external !== 'boolean') errors.push(`element "${el.id}": external must be true or false`);
    if (typeof el.name === 'string' && [...el.name].length > MAX_NAME) errors.push(`element "${el.id}": name is ${[...el.name].length} characters; keep it under ${MAX_NAME}`);
    const id = el.id as string;
    if (parentIds.has(id) && typeof el.name === 'string' && [...el.name].length > GROUP_NAME_BUDGET) warnings.push(`group "${id}" name is ${[...el.name].length} characters; keep it under ${GROUP_NAME_BUDGET}, since a group is never narrower than its name`);
    if (byId.has(id)) { errors.push(`element id "${id}" is used more than once`); badIds = true; }
    byId.set(id, el);
    if (el.name !== undefined && typeof el.name !== 'string') errors.push(`element "${id}": name must be text`);
    else if (!text(el.name)) errors.push(`element "${id}" has no name`);
    if (!oneOf(ELEMENT_TYPES, el.type)) errors.push(`element "${id}" has unknown type "${String(el.type)}"`);
    if (el.status !== undefined && !oneOf(STATUSES, el.status)) {
      errors.push(`element "${id}" has unknown status "${String(el.status)}"`);
    }
    const type = String(el.type);
    if (NEEDS_TECHNOLOGY.has(type) && textField(el, 'technology') && !text(el.technology)) warnings.push(`${type} "${id}" has no technology`);
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
      if (!badIds) errors.push(`element "${id}" has parent "${String(el.parent)}", which does not exist`);
      continue;
    }
    const holder = String(byId.get(el.parent)!.type);
    if (oneOf(ELEMENT_TYPES, holder) && !HOLDERS.has(holder)) errors.push(`element "${id}" has parent "${el.parent}", which is a ${holder}; only a boundary, node, system, container or component holds other elements`);
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
    unknown(rel, RELATIONSHIP_KEYS, `relationships[${i}]`);
    let dangling = false;
    for (const end of ['from', 'to'] as const) {
      if (rel[end] === undefined) { errors.push(`relationships[${i}] has no ${end}`); dangling = true; }
      else if (typeof rel[end] !== 'string') { errors.push(`relationships[${i}]: ${end} must be text, the id of an element`); dangling = true; }
    }
    if (dangling) return;
    const where = `relationship ${String(rel.from)} -> ${String(rel.to)}`;
    for (const end of ['from', 'to'] as const) {
      if (!byId.has(rel[end] as string)) {
        if (!badIds) errors.push(`${where}: ${end} "${String(rel[end])}" does not exist`);
        dangling = true;
      }
    }
    for (const key of ['label', 'technology', 'fromSymbol', 'toSymbol']) if (!textField(rel, key)) { errors.push(`${where}: ${key} must be text`); dangling = true; }
    if (dangling && (typeof rel.label !== 'string' && rel.label !== undefined)) return;
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
    for (const [end, key] of [['from', 'fromSymbol'], ['to', 'toSymbol']] as const) {
      const symbols = dangling ? undefined : byId.get(rel[end] as string)!.symbols;
      if (Array.isArray(symbols) && symbols.findIndex((sym) => isBag(sym) && sym.name === rel[key]) >= MAX_SYMBOLS) {
        warnings.push(`${where}: ${key} "${String(rel[key])}" is past the ${MAX_SYMBOLS} rows a file draws, so the line ends on the file; list it among the first ${MAX_SYMBOLS}`);
      }
    }
    if ([...label].length > LABEL_BUDGET) warnings.push(`${where} label is ${[...label].length} characters; keep it under ${LABEL_BUDGET}, and put the rest in the text`);
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
  } else if (!errors.length) {
    // Past its budget a diagram has no layout that reads well. The warning names the filter that brings it back in.
    const typed = spec as unknown as DiagramSpec;
    const much = over(typed);
    if (much.length) {
      const cut = trim(typed);
      warnings.push(`${much.join(', and ')}; ${cut ? `\`${cut.command}\` leaves ${cut.boxes} and ${cut.lines}` : 'no filter brings it inside and keeps the change, so cut by hand or draw two diagrams (`graph split`)'}`);
    }
  }
  return { errors, warnings };
}
