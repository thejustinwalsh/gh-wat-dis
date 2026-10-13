import type { ElementType, Provenance } from '../spec.ts';

export type { Provenance };
export type FactSource = 'git' | 'ast-grep' | 'codeowners' | 'manifest' | 'config' | 'cccc';
export type FileKind =
  | 'source' | 'test' | 'config' | 'ci' | 'docs' | 'migration' | 'schema' | 'manifest' | 'lockfile' | 'generated' | 'other';
export type Language = 'typescript' | 'javascript' | 'rust';
export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-changed';
export type SymbolChangeKind = 'added' | 'removed' | 'modified';
export type ElementStatus = 'changed' | 'added' | 'removed' | 'affected' | 'unchanged';
export type EdgeStatus = 'added' | 'removed' | 'unchanged';
export type DependencyChangeKind = 'added' | 'removed' | 'bumped';

export interface Unavailable { tool: string; reason: string }
export interface Tiers {
  ran: string[];
  /** Languages that had at least one file parsed. */
  languages: Language[];
  unavailable: Unavailable[];
}

export interface FactsSummary {
  filesChanged: number;
  insertions: number;
  deletions: number;
  byKind: Partial<Record<FileKind, number>>;
  elementsChanged: number;
  directDependents: number;
  exportedSignatureChanges: number;
  /** Present when cccc ran. Sums cover the functions in `complexity[]`, not the whole files. */
  complexity?: { functions: number; cognitiveBefore: number; cognitiveAfter: number; largestRise: number; highestAfter: number };
}

/** Cognitive (SonarSource) and cyclomatic (McCabe) complexity of one function. */
export interface Score { cognitive: number; cyclomatic: number }

/** A function whose complexity the change moved, or one it added or removed. Callbacks count toward the named function around them. */
export interface ComplexityFact {
  file: string;
  /** `outer > inner` for a named function inside another. `<top level>` for callbacks outside every named function. */
  name: string;
  kind: string;
  /** First line on head, or on base for a removed function. */
  line: number;
  change: SymbolChangeKind;
  before?: Score;
  after?: Score;
  provenance: 'measured';
  source: 'cccc';
}

export interface FileFact {
  path: string;
  status: FileStatus;
  oldPath?: string;
  insertions: number;
  deletions: number;
  binary?: boolean;
  kind: FileKind;
  language: Language | null;
  element: string;
  owners: string[];
  /** Commits that touched the file in the 90 days before `now`. */
  churn90d: number;
  /** Enclosing function text git printed in the hunk headers. */
  hunkFunctions: string[];
  /** Set when the file is source in a known language and was not parsed, with the reason. It then has no symbol and no import facts. */
  skipped?: string;
  provenance: Provenance;
  source: FactSource;
}

/** `inDiff` is true when the dependent file is itself part of the change. */
export interface SymbolDependent { file: string; element: string; inDiff: boolean; provenance: Provenance }

export interface SymbolFact {
  name: string;
  kind: string;
  file: string;
  element: string;
  exported: boolean;
  change: SymbolChangeKind;
  signatureChanged: boolean;
  /** Lines of the declaration the change added or took away, comments and blank lines aside. */
  lines: number;
  before?: string;
  after?: string;
  dependents: SymbolDependent[];
  provenance: Provenance;
  source: FactSource;
}

/** An import a changed file gained or lost. `names` are the names it now imports, or no longer imports, from `to`. */
export interface ImportFact {
  from: string;
  to: string;
  toElement: string;
  /** True when `to` is itself in the diff. */
  toInDiff: boolean;
  names: string[];
  /** Namespace, glob, require or dynamic import: the module as a whole. */
  whole: boolean;
  change: 'added' | 'removed';
  provenance: 'resolved';
}

export interface DirectDependent {
  file: string;
  element: string;
  /** Changed files this file imports. */
  imports: string[];
  /** Import specifiers or `use` paths as written. */
  via: string[];
  /** Changed symbols this file names. */
  symbols: string[];
  isTest: boolean;
  provenance: Provenance;
}

export interface TransitiveRollup { element: string; count: number; minDepth: number; provenance: 'measured' }

export interface ElementFact {
  id: string;
  name: string;
  type: ElementType;
  technology?: string;
  description?: string;
  parent?: string;
  external?: boolean;
  status: ElementStatus;
  files: number;
  filesChanged: number;
  dependentsAffected: number;
  provenance: Provenance;
  source: FactSource;
}

export interface EdgeFact {
  from: string;
  to: string;
  /** File-to-file imports from `from` into `to` on head. 0 for an edge that is only declared. */
  weight: number;
  status: EdgeStatus;
  label?: string;
  technology?: string;
  provenance: Provenance;
  source: FactSource;
}

export interface ContractFact { path: string; kind: string; note: string; provenance: Provenance }
export interface CoChangeFact { file: string; withFile: string; commits: number; ratio: number; provenance: 'measured' }
export interface DependencyFact {
  manifest: string;
  name: string;
  section: string;
  change: DependencyChangeKind;
  from?: string;
  to?: string;
  provenance: 'exact';
}
export interface OwnerFact { owner: string; files: string[]; dependentFiles: string[] }

export interface Facts {
  schema: 1;
  /** Commit sha of the base side. */
  base: string;
  /** Commit sha of the head side, or "WORKING_TREE". */
  head: string;
  range: { baseRef: string; headRef: string; workingTree: boolean; depth: number };
  /** Web address of the repository, from the `origin` remote. Absent when there is none. */
  repository?: string;
  tiers: Tiers;
  summary: FactsSummary;
  files: FileFact[];
  symbols: SymbolFact[];
  dependents: { direct: DirectDependent[]; transitive: TransitiveRollup[] };
  /** Imports the changed files gained or lost, by file. Empty when no changed file was parsed on both sides. */
  imports: ImportFact[];
  elements: ElementFact[];
  edges: EdgeFact[];
  contracts: ContractFact[];
  tests: { changed: string[]; importingChanged: string[] };
  coChange: CoChangeFact[];
  dependencies: DependencyFact[];
  /** Empty when cccc did not run: see `tiers`. Largest change in cognitive complexity first. */
  complexity: ComplexityFact[];
  owners: OwnerFact[];
  caveats: string[];
}

export interface AnalyzeOptions {
  cwd?: string;
  base?: string;
  head?: string;
  workingTree?: boolean;
  depth?: number;
  now?: Date;
  /** Path of the cccc binary. `null`: looked for and not found, which the facts then say. Omitted: complexity is not measured. */
  cccc?: string | null;
}

export interface MarkdownOptions { maxItems?: number; heading?: string | false; /** Link file paths to the repository. Default true. */ links?: boolean }
export interface SpecOptions { title?: string; all?: boolean }

export interface OwnerMatch { path: string; owners: string[]; rule: string | null; file: string | null; line?: number; provenance: 'exact' }

export interface ElementListing {
  id: string;
  name: string;
  type: ElementType;
  technology?: string;
  description?: string;
  parent?: string;
  external?: boolean;
  found: 'config' | 'workspace' | 'directory';
  files: number;
  /** Globs that matched at least one file. */
  globs: string[];
  provenance: Provenance;
  source: FactSource;
}
export interface ElementsResult { schema: 1; mapping: 'config' | 'workspace' | 'directory'; elements: ElementListing[]; unmapped: string[] }

export interface ReachDependent { file: string; element: string; via: string[]; isTest: boolean; depth: 1; provenance: Provenance }
export interface ReachMatch {
  file: string;
  symbol?: string;
  kind?: string;
  element: string;
  direct: ReachDependent[];
  transitive: TransitiveRollup[];
}
export interface ReachTarget { target: string; found: boolean; ambiguous: boolean; matches: ReachMatch[] }
export interface ReachResult { schema: 1; depth: number; tiers: Tiers; targets: ReachTarget[]; caveats: string[] }
export interface ReachOptions { cwd?: string; targets: string[]; depth?: number }
