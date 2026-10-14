// Parts: what a user or another program calls by name. A command, a tool, a skill, an HTTP route, a scheduled job,
// a `bin` or an `exports` entry. The architecture map names elements, not these, so a change that adds one shows in
// the other facts only as an element that changed. Each part here is read from something the tools can prove: a
// file whose name is the definition (SKILL.md), a manifest field, or a registration the AST parse sees.
import { Lang, parse } from '@ast-grep/napi';
import type { SgNode } from '@ast-grep/napi';
import { extOf, languageOf } from './classify.ts';
import { parseJson } from './manifests.ts';
import { rustUnavailable } from './rust-parse.ts';
import { code } from './symbols.ts';
import { parseToml, tomlTable } from './toml.ts';
import type { FactSource, PartKind, Provenance } from './types.ts';

/** A part as one side of the change declares it. */
export interface Declared {
  kind: PartKind;
  name: string;
  line: number;
  basis: string;
  provenance: Provenance;
  source: FactSource;
  /** The module a registry entry loads its code from, as written. */
  target?: string;
}

const unquote = (n: SgNode | null | undefined): string | null => (n && /^string/.test(String(n.kind())) ? n.text().slice(1, -1) : null);
const lineOf = (n: SgNode): number => n.range().start.line + 1;

// A registry is a top-level list or object whose name says what it holds: COMMANDS, TOOLS, cliCommands, API_ROUTES.
const WORDS = 'commands?|subcommands?|tools?|routes?|jobs?|crons?';
const REGISTRY = [new RegExp(`^(${WORDS})$`, 'i'), new RegExp(`_(${WORDS})$`, 'i'), /[a-z0-9](Commands?|Subcommands?|Tools?|Routes?|Jobs?|Crons?)$/];
const registryKind = (name: string): PartKind | null => {
  if (!REGISTRY.some((r) => r.test(name))) return null;
  return /route/i.test(name) ? 'route' : /job|cron/i.test(name) ? 'job' : /tool/i.test(name) ? 'tool' : 'command';
};
const HTTP = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);
const CRON = /^\S+(\s+\S+){4,5}$/;

function unwrap(n: SgNode | null): SgNode | null {
  let at = n;
  while (at && /^(as_expression|satisfies_expression|parenthesized_expression|non_null_expression)$/.test(String(at.kind()))) at = at.children().find((c) => c.isNamed()) ?? null;
  return at;
}

/** The module a handler loads: `import('./x')`, a loader such as `const gh = () => import('./x')`, or a name imported from it. */
function targetOf(text: string, loaders: Map<string, string>, bindings: Map<string, string>): string | undefined {
  const direct = text.match(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/);
  if (direct) return direct[1];
  for (const m of text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) if (loaders.has(m[1]!)) return loaders.get(m[1]!);
  for (const m of text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)/g)) if (bindings.has(m[1]!)) return bindings.get(m[1]!);
  return undefined;
}

function tsParts(path: string, text: string): Declared[] {
  const ext = extOf(path);
  const root = parse(ext === 'tsx' ? Lang.Tsx : ext.includes('ts') ? Lang.TypeScript : Lang.JavaScript, text).root();
  const out: Declared[] = [];
  const loaders = new Map<string, string>();
  const bindings = new Map<string, string>();
  for (const m of text.matchAll(/^\s*import\s+(?:type\s+)?(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/gm)) {
    if (m[1]) bindings.set(m[1], m[3]!);
    for (const s of (m[2] ?? '').split(',')) { const local = s.trim().split(/\s+as\s+/).pop()?.trim(); if (local) bindings.set(local, m[3]!); }
  }
  const declarators: SgNode[] = [];
  for (const st of root.children()) {
    const decl = st.kind() === 'export_statement' ? st.field('declaration') : st;
    if (decl && /^(lexical_declaration|variable_declaration)$/.test(String(decl.kind()))) declarators.push(...decl.children().filter((c) => c.kind() === 'variable_declarator'));
  }
  for (const d of declarators) {
    const name = d.field('name')?.text() ?? '';
    const value = unwrap(d.field('value'));
    const load = value && /^(arrow_function|function_expression)$/.test(String(value.kind())) ? value.field('body')?.text().match(/^\(?\s*(?:await\s+)?import\(\s*['"]([^'"]+)['"]\s*\)/) : null;
    if (load) loaders.set(name, load[1]!);
  }
  for (const d of declarators) {
    const name = d.field('name')?.text() ?? '';
    const kind = registryKind(name);
    const value = unwrap(d.field('value'));
    if (!kind || !value) continue;
    const basis = `${name} in ${path}`;
    const add = (part: string | null, at: SgNode, handler?: SgNode | null): void => {
      if (!part) return;
      const target = handler ? targetOf(handler.text(), loaders, bindings) : undefined;
      out.push({ kind, name: part, line: lineOf(at), basis, provenance: 'heuristic', source: 'ast-grep', ...(target ? { target } : {}) });
    };
    if (value.kind() === 'object') {
      for (const c of value.children()) {
        if (c.kind() === 'pair') {
          const key = c.field('key');
          add(key?.kind() === 'property_identifier' ? key.text() : unquote(key), c, c.field('value'));
        } else if (c.kind() === 'shorthand_property_identifier') add(c.text(), c, c);
        else if (c.kind() === 'method_definition') add(c.field('name')?.text() ?? null, c, c);
      }
    } else if (value.kind() === 'array') {
      for (const c of value.children()) {
        if (/^string/.test(String(c.kind()))) add(unquote(c), c);
        else if (c.kind() === 'object') {
          const pairs = c.children().filter((p) => p.kind() === 'pair');
          const keyOf = (p: SgNode): string => p.field('key')?.text().replace(/['"]/g, '') ?? '';
          const entry = unquote(pairs.find((p) => /^(name|command|path|route)$/.test(keyOf(p)))?.field('value'));
          add(entry, c, c);
          // The flags a usage line lists are the options a person types after the command.
          const usage = unquote(pairs.find((p) => /^(usage|synopsis|flags|options|args)$/.test(keyOf(p)))?.field('value'));
          if (entry && usage) for (const flag of new Set(usage.match(/(?<![\w-])--[a-z][\w-]*/g) ?? [])) out.push({ kind: 'option', name: `${entry} ${flag}`, line: lineOf(c), basis, provenance: 'heuristic', source: 'ast-grep' });
        }
      }
    }
  }
  if (/\.(command|registerCommand|registerTextEditorCommand|option|requiredOption|route|schedule|get|post|put|patch|delete|head|options|all)\s*\(/.test(text)) {
    for (const call of root.findAll({ rule: { kind: 'call_expression' } })) {
      const fn = call.field('function');
      if (fn?.kind() !== 'member_expression') continue;
      const prop = fn.field('property')?.text() ?? '';
      const arg = unquote(call.field('arguments')?.children().find((c) => c.isNamed()));
      if (!arg) continue;
      if ((prop === 'option' || prop === 'requiredOption') && /--[a-z]/.test(arg)) out.push({ kind: 'option', name: arg.match(/--[a-z][\w-]*/)![0], line: lineOf(call), basis: `.${prop}() in ${path}`, provenance: 'heuristic', source: 'ast-grep' });
      else if (prop === 'command' || prop === 'registerCommand' || prop === 'registerTextEditorCommand') out.push({ kind: 'command', name: prop === 'command' ? arg.split(/\s+/)[0]! : arg, line: lineOf(call), basis: `.${prop}() in ${path}`, provenance: 'heuristic', source: 'ast-grep' });
      else if ((HTTP.has(prop) || prop === 'route') && arg.startsWith('/')) out.push({ kind: 'route', name: HTTP.has(prop) ? `${prop.toUpperCase()} ${arg}` : arg, line: lineOf(call), basis: `.${prop}() in ${path}`, provenance: 'heuristic', source: 'ast-grep' });
      else if (prop === 'schedule' && CRON.test(arg.trim())) out.push({ kind: 'job', name: arg.trim(), line: lineOf(call), basis: `.schedule() in ${path}`, provenance: 'heuristic', source: 'ast-grep' });
    }
  }
  return out;
}

const kebab = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

function rustParts(path: string, text: string): Declared[] {
  if (rustUnavailable()) return [];
  const root = parse('rust', text).root();
  const out: Declared[] = [];
  if (/\.route\s*\(/.test(text)) {
    for (const call of root.findAll({ rule: { kind: 'call_expression' } })) {
      const fn = call.field('function');
      if (fn?.kind() !== 'field_expression' || fn.field('field')?.text() !== 'route') continue;
      const first = call.field('arguments')?.children().find((c) => c.isNamed());
      const arg = first?.kind() === 'string_literal' ? first.text().slice(1, -1) : null;
      if (arg?.startsWith('/')) out.push({ kind: 'route', name: arg, line: lineOf(call), basis: `.route() in ${path}`, provenance: 'heuristic', source: 'ast-grep' });
    }
  }
  for (const attr of root.findAll({ rule: { kind: 'attribute_item' } })) {
    const m = attr.text().match(/^#\[\s*(?:[\w:]+::)?(get|post|put|patch|delete|head|options)\s*\(\s*"([^"]+)"/);
    if (m) out.push({ kind: 'route', name: `${m[1]!.toUpperCase()} ${m[2]}`, line: lineOf(attr), basis: `#[${m[1]}] in ${path}`, provenance: 'heuristic', source: 'ast-grep' });
  }
  // A clap argument with a long flag: `#[arg(long)] dry_run: bool` is `--dry-run`.
  if (/#\[(arg|clap)\(/.test(text)) {
    for (const field of root.findAll({ rule: { kind: 'field_declaration' } })) {
      let long: string | undefined;
      for (let p = field.prev(); p && p.kind() === 'attribute_item'; p = p.prev()) {
        const m = p.text().match(/^#\[\s*(?:arg|clap)\s*\(([\s\S]*)\)\s*\]$/);
        if (m && /\blong\b/.test(m[1]!)) long ??= m[1]!.match(/\blong\s*=\s*"([^"]+)"/)?.[1] ?? (field.field('name')?.text() ?? '').replace(/_/g, '-');
      }
      if (long) out.push({ kind: 'option', name: `--${long}`, line: lineOf(field), basis: `clap #[arg(long)] in ${path}`, provenance: 'heuristic', source: 'ast-grep' });
    }
  }
  // A clap subcommand enum: each variant is a command, named in kebab case unless an attribute names it.
  if (/Subcommand/.test(text)) {
    for (const en of root.findAll({ rule: { kind: 'enum_item' } })) {
      let derives = false;
      for (let p = en.prev(); p && p.kind() === 'attribute_item'; p = p.prev()) if (/derive\([^)]*\bSubcommand\b/.test(p.text())) derives = true;
      if (!derives) continue;
      const enumName = en.field('name')?.text() ?? 'enum';
      for (const v of en.field('body')?.children().filter((c) => c.kind() === 'enum_variant') ?? []) {
        let named: string | undefined;
        for (let p = v.prev(); p && p.kind() === 'attribute_item'; p = p.prev()) named ??= p.text().match(/\bname\s*=\s*"([^"]+)"/)?.[1];
        const id = v.field('name')?.text();
        if (id) out.push({ kind: 'command', name: named ?? kebab(id), line: lineOf(v), basis: `clap Subcommand ${enumName} in ${path}`, provenance: 'heuristic', source: 'ast-grep' });
      }
    }
  }
  return out;
}

/** The parts a source file registers, read with the AST parser. */
export function sourceParts(path: string, text: string | undefined): Declared[] {
  if (text === undefined) return [];
  const lang = languageOf(path);
  try {
    return lang === 'rust' ? rustParts(path, text) : lang ? tsParts(path, text) : [];
  } catch { return []; }
}

/** `bin` and `exports` entries of a package.json, `[[bin]]` targets of a Cargo.toml. */
export function manifestParts(path: string, text: string | undefined): Declared[] {
  if (text === undefined) return [];
  const out: Declared[] = [];
  const line = (needle: string): number => Math.max(1, text.split('\n').findIndex((l) => l.includes(needle)) + 1);
  if (path.endsWith('package.json')) {
    const pkg = parseJson(text);
    if (!pkg) return [];
    const bin = pkg.bin;
    const pkgName = typeof pkg.name === 'string' ? pkg.name.replace(/^@[^/]+\//, '') : null;
    const bins: [string, string][] = typeof bin === 'string' && pkgName ? [[pkgName, bin]] : bin && typeof bin === 'object' ? Object.entries(bin as Record<string, unknown>).map(([k, v]) => [k, String(v)]) : [];
    for (const [name, target] of bins) out.push({ kind: 'bin', name, line: line(`"${target}"`), basis: `${path} bin`, provenance: 'exact', source: 'manifest', target });
    const exp = pkg.exports;
    const keys = typeof exp === 'string' ? ['.'] : exp && typeof exp === 'object' ? (Object.keys(exp).some((k) => k.startsWith('.')) ? Object.keys(exp).filter((k) => k.startsWith('.')) : ['.']) : [];
    for (const k of keys) out.push({ kind: 'export', name: k, line: line(`"${k}"`), basis: `${path} exports`, provenance: 'exact', source: 'manifest' });
    // A VS Code extension lists the commands a person runs from the palette.
    const contributed = (pkg.contributes as { commands?: unknown } | undefined)?.commands;
    for (const c of Array.isArray(contributed) ? contributed : []) {
      const id = (c as { command?: unknown })?.command;
      if (typeof id === 'string') out.push({ kind: 'command', name: id, line: line(`"${id}"`), basis: `${path} contributes.commands`, provenance: 'exact', source: 'manifest' });
    }
  } else if (path.endsWith('Cargo.toml')) {
    try {
      const bins = parseToml(text).bin;
      for (const b of Array.isArray(bins) ? bins : []) {
        const t = tomlTable(b);
        if (typeof t.name === 'string') out.push({ kind: 'bin', name: t.name, line: line(`"${t.name}"`), basis: `${path} [[bin]]`, provenance: 'exact', source: 'manifest', ...(typeof t.path === 'string' ? { target: t.path } : {}) });
      }
    } catch { /* an unreadable manifest declares nothing */ }
  }
  return out;
}

export const isWorkflow = (path: string): boolean => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path);

/** The schedules of a GitHub Actions workflow: each `cron` line is a job that runs by itself. */
export function workflowParts(path: string, text: string | undefined): Declared[] {
  if (text === undefined) return [];
  const out: Declared[] = [];
  text.split('\n').forEach((l, i) => {
    const m = l.match(/^\s*-?\s*cron:\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/);
    if (m) out.push({ kind: 'job', name: `${path.slice(path.lastIndexOf('/') + 1)} at ${m[1]!.trim()}`, line: i + 1, basis: `schedule in ${path}`, provenance: 'exact', source: 'git' });
  });
  return out;
}

/** A part that is a file of its own: a skill's SKILL.md, a Next.js route handler, a Rust `src/bin` target. */
export function fileParts(path: string): Declared[] {
  const skill = path.match(/(?:^|\/)([^/]+)\/SKILL\.md$/);
  if (skill) return [{ kind: 'skill', name: skill[1]!, line: 1, basis: 'SKILL.md', provenance: 'exact', source: 'git' }];
  const next = path.match(/(?:^|\/)app\/((?:[^/]+\/)*)route\.[cm]?[jt]sx?$/);
  if (next) return [{ kind: 'route', name: `/${next[1]!.split('/').filter((s) => s && !/^\(.*\)$/.test(s)).join('/')}`, line: 1, basis: 'Next.js route file', provenance: 'heuristic', source: 'git' }];
  const api = path.match(/(?:^|\/)pages\/(api\/.+?)(?:\/index)?\.[cm]?[jt]sx?$/);
  if (api) return [{ kind: 'route', name: `/${api[1]}`, line: 1, basis: 'Next.js API file', provenance: 'heuristic', source: 'git' }];
  const bin = path.match(/(?:^|\/)src\/bin\/([^/]+?)(?:\/main)?\.rs$/);
  if (bin) return [{ kind: 'bin', name: bin[1]!, line: 1, basis: 'Rust src/bin target', provenance: 'heuristic', source: 'git' }];
  return [];
}

/**
 * Parts on head that base lacks, and the other way round. One file can list a part twice (a dispatch table and a help
 * list): it counts once, with the handler of whichever entry names one. An entry with no handler, such as
 * "graph from-facts", takes the handler of the entry named by its first word.
 */
export function diffParts(base: Declared[], head: Declared[]): { added: Declared[]; removed: Declared[] } {
  const merge = (xs: Declared[]): Map<string, Declared> => {
    const out = new Map<string, Declared>();
    for (const x of xs) {
      const cur = out.get(x.name);
      if (!cur) out.set(x.name, { ...x });
      else if (!cur.target && x.target) cur.target = x.target;
    }
    for (const x of out.values()) if (!x.target && x.name.includes(' ')) { const t = out.get(x.name.split(' ')[0]!)?.target; if (t) x.target = t; }
    return out;
  };
  const a = merge(base), b = merge(head);
  const added = [...b.values()].filter((x) => !a.has(x.name)), removed = [...a.values()].filter((x) => !b.has(x.name));
  // The options of a command that comes or goes come and go with it.
  const whole = (xs: Declared[]): Declared[] => {
    const cmds = new Set(xs.filter((x) => x.kind !== 'option').map((x) => x.name));
    return xs.filter((x) => x.kind !== 'option' || !cmds.has(x.name.slice(0, x.name.lastIndexOf(' --'))));
  };
  return { added: whole(added), removed: whole(removed) };
}

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'await', 'new', 'match', 'loop', 'fn', 'Some', 'Ok', 'Err', 'super', 'import', 'require']);

/** The functions a body calls, in the order they are written, without the declaration's own name. */
export function callOrder(name: string, text: string): string[] {
  const own = name.slice(name.lastIndexOf('.') + 1);
  const calls = [...code(text).matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\s*(?:::<[^>]*>)?\s*!?\(/g)].map((m) => m[1]!).filter((n) => !KEYWORDS.has(n));
  if (calls[0] === own) calls.shift();
  return calls;
}

/** The same calls as before, in another order: the order of the steps changed. */
export function reordered(name: string, before: string, after: string): boolean {
  const a = callOrder(name, before), b = callOrder(name, after);
  return a.length >= 2 && a.join('\0') !== b.join('\0') && [...a].sort().join('\0') === [...b].sort().join('\0');
}
