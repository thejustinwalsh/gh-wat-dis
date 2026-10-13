// The diagram spec is the one format every graph tool reads and writes.
// `impact` and the architecture map produce it, `graph` reshapes it, `diagram` renders it,
// and an agent can edit it by hand at any step.

export const DIAGRAM_TYPES = ['context', 'container', 'component', 'code', 'dynamic', 'deployment', 'landscape'] as const;
export type DiagramType = (typeof DIAGRAM_TYPES)[number];

/** The types an architecture map may hold. */
export const MAP_ELEMENT_TYPES = ['person', 'system', 'container', 'component', 'datastore', 'queue', 'boundary', 'node'] as const;
/** A `file` is one source file in a `code` diagram: a card with a row for each symbol the change touched. */
export const ELEMENT_TYPES = [...MAP_ELEMENT_TYPES, 'file'] as const;
export type ElementType = (typeof ELEMENT_TYPES)[number];

export const STATUSES = ['added', 'changed', 'removed', 'affected', 'unchanged'] as const;
export type Status = (typeof STATUSES)[number];

export const PROVENANCE = ['exact', 'resolved', 'measured', 'heuristic'] as const;
/** The kind of source behind a fact. It names where the fact came from. It is not a rating. */
export type Provenance = (typeof PROVENANCE)[number];

export const DETAILS = ['auto', 'full', 'compact'] as const;
export type Detail = (typeof DETAILS)[number];

export const LABEL_MODES = ['auto', 'text', 'numbered'] as const;
/** `numbered` draws a number on each relationship; the words go in a legend table beside the diagram. */
export type LabelMode = (typeof LABEL_MODES)[number];

/** One row of a `file` card. No status means the change did not touch the symbol: list it only when a line ends on it. */
export interface SpecSymbol {
  name: string;
  /** "function", "const", "interface", "struct". Drawn small beside the name. */
  kind?: string;
  status?: Status;
}

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
  /** On a `file`: the symbols the change added, changed or removed. */
  symbols?: SpecSymbol[];
  /** Free-form data that tools pass along and the renderer ignores. */
  meta?: Record<string, unknown>;
}

export interface SpecRelationship {
  from: string;
  to: string;
  /** Between two files it may be empty: the line then means an import. */
  label: string;
  /** The symbol row of a `file` the line leaves from or ends on. */
  fromSymbol?: string;
  toSymbol?: string;
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
  /** `auto` (default) keeps the words on the lines when the diagram reads well that way, and numbers them when it does not. */
  labels?: LabelMode;
  elements: SpecElement[];
  relationships: SpecRelationship[];
}

export interface LintResult {
  errors: string[];
  warnings: string[];
}
