import { Lang, parse } from '@ast-grep/napi';
import type { SgNode } from '@ast-grep/napi';
import { extOf } from './classify.ts';
import type { RawImport, Sym } from './model.ts';

export interface ParsedTs { syms: Sym[]; imports: RawImport[] }

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();
const unquote = (n: SgNode | null): string | null => (n && /^string/.test(String(n.kind())) ? n.text().slice(1, -1) : null);
const langOf = (path: string): Lang => {
  const ext = extOf(path);
  return ext === 'tsx' ? Lang.Tsx : ext.includes('ts') ? Lang.TypeScript : Lang.JavaScript;
};

const DECL_KIND: Record<string, string> = {
  function_declaration: 'function', generator_function_declaration: 'function', function_signature: 'function',
  class_declaration: 'class', abstract_class_declaration: 'class',
  type_alias_declaration: 'type', interface_declaration: 'interface', enum_declaration: 'enum',
  internal_module: 'namespace', module: 'namespace',
};
const WHOLE_TEXT = new Set(['type', 'interface', 'enum']);

function headerOf(node: SgNode, kind: string): string {
  if (WHOLE_TEXT.has(kind)) return squash(node.text());
  const body = node.field('body');
  return squash(body ? node.text().slice(0, body.range().start.index - node.range().start.index) : node.text()).replace(/;$/, '');
}

class Collector {
  syms: Sym[] = [];
  imports: RawImport[] = [];
  bindings = new Map<string, { spec: string; name: string }>();
  detail: boolean;
  constructor(detail: boolean) { this.detail = detail; }

  sym(name: string, kind: string, exported: boolean, range: SgNode, header: SgNode | string, extra: Partial<Sym> = {}): void {
    const r = range.range();
    this.syms.push({
      name, kind, exported, start: r.start.line + 1, end: r.end.line + 1,
      header: !this.detail ? '' : typeof header === 'string' ? header : headerOf(header, kind),
      text: this.detail ? range.text() : '', ...extra,
    });
  }

  declaration(decl: SgNode, outer: SgNode, exported: boolean, isDefault: boolean): void {
    let node = decl;
    if (node.kind() === 'ambient_declaration') node = node.children().find((c) => c.isNamed()) ?? node;
    const k = String(node.kind());
    if (k === 'lexical_declaration' || k === 'variable_declaration') {
      const decls = node.children().filter((c) => c.kind() === 'variable_declarator');
      for (const d of decls) {
        const id = d.field('name');
        if (!id || id.kind() !== 'identifier') continue;
        const value = d.field('value');
        const fn = value && /^(arrow_function|function_expression|generator_function)$/.test(String(value.kind()));
        const cut = fn ? value.field('body') : value;
        const head = squash(cut ? d.text().slice(0, cut.range().start.index - d.range().start.index) : d.text()).replace(/\s*=$/, '');
        this.sym(id.text(), fn ? 'function' : 'const', exported, decls.length === 1 ? outer : d, `const ${head}`);
      }
      return;
    }
    const kind = DECL_KIND[k];
    if (!kind) return;
    const local = node.field('name')?.text();
    const name = isDefault ? 'default' : local;
    if (!name) return;
    this.sym(name, kind, exported, outer, node);
    if (kind === 'class') this.members(node, isDefault ? 'default' : name, exported);
  }

  members(cls: SgNode, owner: string, exported: boolean): void {
    for (const m of cls.field('body')?.children() ?? []) {
      if (!/^(method_definition|method_signature|abstract_method_signature)$/.test(String(m.kind()))) continue;
      const id = m.field('name');
      if (!id || id.kind() === 'private_property_identifier') continue;
      if (m.children().some((c) => c.kind() === 'accessibility_modifier' && c.text() !== 'public')) continue;
      this.sym(`${owner}.${id.text()}`, 'method', exported, m, m, { container: owner });
    }
  }

  importStatement(st: SgNode): void {
    const spec = unquote(st.field('source')) ?? unquote(st.find({ rule: { kind: 'string' } }));
    if (!spec) return;
    const imp: RawImport = { spec, names: [], whole: false };
    const clause = st.children().find((c) => c.kind() === 'import_clause');
    for (const c of clause?.children() ?? []) {
      if (c.kind() === 'identifier') { imp.names.push('default'); this.bindings.set(c.text(), { spec, name: 'default' }); }
      else if (c.kind() === 'namespace_import') imp.whole = true;
      else if (c.kind() === 'named_imports') {
        for (const s of c.children().filter((x) => x.kind() === 'import_specifier')) {
          const name = s.field('name')?.text();
          if (!name) continue;
          imp.names.push(name);
          this.bindings.set(s.field('alias')?.text() ?? name, { spec, name });
        }
      }
    }
    if (st.children().some((c) => c.kind() === 'import_require_clause')) imp.whole = true;
    this.imports.push(imp);
  }

  exportStatement(st: SgNode, localExports: Map<string, { name: string; node: SgNode }>): void {
    const spec = unquote(st.field('source'));
    const clause = st.children().find((c) => c.kind() === 'export_clause');
    const specifiers = (clause?.children() ?? []).filter((c) => c.kind() === 'export_specifier')
      .map((s) => ({ name: s.field('name')?.text() ?? '', alias: s.field('alias')?.text(), node: s }));
    if (spec) {
      const ns = st.children().find((c) => c.kind() === 'namespace_export');
      const imp: RawImport = { spec, names: specifiers.map((s) => s.name), whole: !clause };
      this.imports.push(imp);
      if (ns) this.sym(ns.children().find((c) => c.isNamed())?.text() ?? '*', 'reexport', true, st, squash(st.text()), { reexport: { spec, name: '*' } });
      else if (!clause) this.sym('*', 'reexport', true, st, squash(st.text()), { reexport: { spec, name: '*' } });
      // Each name is its own declaration: adding one name to the list changes that name alone.
      for (const s of specifiers) {
        const header = `export { ${s.alias ? `${s.name} as ${s.alias}` : s.name} } from '${spec}'`;
        this.sym(s.alias ?? s.name, 'reexport', true, s.node, header, { reexport: { spec, name: s.name }, ...(this.detail ? { text: header } : {}) });
      }
      return;
    }
    if (clause) {
      for (const s of specifiers) localExports.set(s.name, { name: s.alias ?? s.name, node: st });
      return;
    }
    const isDefault = st.children().some((c) => c.kind() === 'default');
    const decl = st.field('declaration');
    if (decl) { this.declaration(decl, st, true, isDefault); return; }
    const value = st.field('value') ?? st.children().find((c) => c.isNamed());
    if (!value) return;
    if (value.kind() === 'identifier') localExports.set(value.text(), { name: 'default', node: st });
    else this.sym('default', /function|class/.test(String(value.kind())) ? (String(value.kind()).includes('class') ? 'class' : 'function') : 'default', true, st, /function|class/.test(String(value.kind())) ? value : 'export default <expression>');
  }

  calls(root: SgNode): void {
    for (const call of root.findAll({ rule: { kind: 'call_expression' } })) {
      const fn = call.field('function');
      if (!fn || !((fn.kind() === 'identifier' && fn.text() === 'require') || fn.kind() === 'import')) continue;
      const spec = unquote(call.field('arguments')?.children().find((c) => c.isNamed()) ?? null);
      if (spec) this.imports.push({ spec, names: [], whole: true });
    }
  }

  finish(localExports: Map<string, { name: string; node: SgNode }>): void {
    for (const [local, exp] of localExports) {
      const hits = this.syms.filter((s) => !s.reexport && (s.name === local || s.name.startsWith(`${local}.`)));
      for (const s of hits) {
        s.exported = true;
        if (exp.name !== local) {
          if (s.name === local) s.name = exp.name; else if (s.name.startsWith(`${local}.`)) { s.name = `${exp.name}${s.name.slice(local.length)}`; s.container = exp.name; }
        }
      }
      const bound = this.bindings.get(local);
      if (!hits.length && bound) this.sym(exp.name, 'reexport', true, exp.node, `export { ${local} } from '${bound.spec}'`, { reexport: { spec: bound.spec, name: bound.name } });
    }
  }
}

export function parseTs(path: string, text: string, detail: boolean): ParsedTs {
  const root = parse(langOf(path), text).root();
  const c = new Collector(detail);
  const localExports = new Map<string, { name: string; node: SgNode }>();
  for (const st of root.children()) {
    const k = st.kind();
    if (k === 'import_statement') c.importStatement(st);
    else if (k === 'export_statement') c.exportStatement(st, localExports);
    else if (st.isNamed()) c.declaration(st, st, false, false);
  }
  if (/\brequire\s*\(|\bimport\s*\(/.test(text)) c.calls(root);
  c.finish(localExports);
  return { syms: c.syms, imports: c.imports };
}
