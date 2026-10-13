// The diagram spec is the one format every graph tool reads and writes.
// `impact` and the architecture map produce it, `graph` reshapes it, `diagram` renders it,
// and an agent can edit it by hand at any step.

export const DIAGRAM_TYPES = ['context', 'container', 'component', 'dynamic', 'deployment', 'landscape'] as const;
export type DiagramType = (typeof DIAGRAM_TYPES)[number];

export const ELEMENT_TYPES = ['person', 'system', 'container', 'component', 'datastore', 'queue', 'boundary', 'node'] as const;
export type ElementType = (typeof ELEMENT_TYPES)[number];

export const STATUSES = ['added', 'changed', 'removed', 'affected', 'unchanged'] as const;
export type Status = (typeof STATUSES)[number];

export const PROVENANCE = ['exact', 'resolved', 'measured', 'heuristic'] as const;
/** The kind of source behind a fact. It names where the fact came from. It is not a rating. */
export type Provenance = (typeof PROVENANCE)[number];

export const DETAILS = ['auto', 'full', 'compact'] as const;
export type Detail = (typeof DETAILS)[number];

export interface SpecElement {
  id: string;
  type: ElementType;
  name: string;
  /** Replaces the type label: "Web Worker", "WASM module", "npm package", "Rust crate", "Thread". */
  kind?: string;
  technology?: string;
  description?: string;
  /** id of a boundary, node or system element that contains this one */
  parent?: string;
  external?: boolean;
  status?: Status;
  /** Free-form data that tools pass along and the renderer ignores. */
  meta?: Record<string, unknown>;
}

export interface SpecRelationship {
  from: string;
  to: string;
  label: string;
  technology?: string;
  status?: Status;
  /** Step number on a dynamic diagram. */
  order?: number;
  meta?: Record<string, unknown>;
}

export interface DiagramSpec {
  title: string;
  type: DiagramType;
  scope?: string;
  direction?: 'DOWN' | 'RIGHT';
  /** How much text each element shows. `auto` (default) drops descriptions once a diagram has more than 5 elements. */
  detail?: Detail;
  elements: SpecElement[];
  relationships: SpecRelationship[];
}

export interface LintResult {
  errors: string[];
  warnings: string[];
}
