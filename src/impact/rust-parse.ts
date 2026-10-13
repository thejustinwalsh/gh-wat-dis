import { parse, registerDynamicLanguage } from '@ast-grep/napi';
import type { SgNode } from '@ast-grep/napi';
import rust from '@ast-grep/lang-rust';
import type { Sym } from './model.ts';

export interface RawUse {
  path: string[];
  glob: boolean;
  pub: boolean;
  alias?: string;
  /** Inline modules that enclose the declaration. */
  modPath: string[];
  test: boolean;
  /** A path written inside an expression or type, not a `use` declaration. */
  inline?: boolean;
  line: number;
  text: string;
}
export interface RawMod { name: string; pathAttr?: string; inline: boolean; modPath: string[]; test: boolean }
export interface ParsedRust { syms: Sym[]; uses: RawUse[]; mods: RawMod[] }

let registered: true | string | undefined;

/** Registers the Rust grammar once. Returns the reason when it cannot load. */
export function rustUnavailable(): string | null {
  if (registered === undefined) {
    try { registerDynamicLanguage({ rust }); registered = true; } catch (e) { registered = e instanceof Error ? e.message : String(e); }
  }
  return registered === true ? null : registered;
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();
const segments = (text: string): string[] => text.replace(/\s+/g, '').replace(/^::/, '').split('::');
const baseType = (text: string): string => text.replace(/<[\s\S]*$/, '').replace(/^[&*\s]+(mut\s+)?(dyn\s+)?/, '').split('::').pop()!.trim();

const ITEM_KIND: Record<string, string> = {
  function_item: 'function', function_signature_item: 'function', struct_item: 'struct', enum_item: 'enum', union_item: 'union',
  trait_item: 'trait', const_item: 'const', static_item: 'static', type_item: 'type',
};
const WHOLE_TEXT = new Set(['struct', 'enum', 'union', 'type']);

class Collector {
  out: ParsedRust = { syms: [], uses: [], mods: [] };
  testRanges: [number, number][] = [];
  inTest = false;
  detail: boolean;
  constructor(detail: boolean) { this.detail = detail; }

  header(node: SgNode, kind: string): string {
    if (!this.detail) return '';
    if (WHOLE_TEXT.has(kind)) return squash(node.text());
    const body = node.field('body');
    const text = body ? node.text().slice(0, body.range().start.index - node.range().start.index) : node.text();
    return squash(kind === 'const' || kind === 'static' ? text.replace(/=[\s\S]*$/, '') : text).replace(/;$/, '');
  }

  sym(name: string, kind: string, exported: boolean, node: SgNode, first: SgNode, extra: Partial<Sym> = {}): void {
    if (this.inTest) return;
    this.out.syms.push({
      name, kind, exported, start: first.range().start.line + 1, end: node.range().end.line + 1,
      header: this.header(node, kind), text: this.detail ? node.text() : '', ...extra,
    });
  }

  flatten(node: SgNode, prefix: string[], emit: (path: string[], glob: boolean, alias?: string) => void): void {
    switch (node.kind()) {
      case 'use_as_clause': {
        const p = node.field('path');
        if (p) emit([...prefix, ...segments(p.text())], false, node.field('alias')?.text());
        break;
      }
      case 'use_wildcard': {
        const inner = node.children().find((c) => c.isNamed());
        emit([...prefix, ...(inner ? segments(inner.text()) : [])], true);
        break;
      }
      case 'use_list':
        for (const c of node.children()) if (c.isNamed()) this.flatten(c, prefix, emit);
        break;
      case 'scoped_use_list': {
        const p = node.field('path');
        const list = node.field('list');
        if (list) this.flatten(list, p ? [...prefix, ...segments(p.text())] : prefix, emit);
        break;
      }
      default:
        emit([...prefix, ...segments(node.text())], false);
    }
  }

  use(node: SgNode, pub: boolean, modPath: string[], test: boolean): void {
    const arg = node.field('argument') ?? node.children().find((c) => c.isNamed() && c.kind() !== 'visibility_modifier');
    if (!arg) return;
    const line = node.range().start.line + 1;
    this.flatten(arg, [], (path, glob, alias) => {
      const p = path[path.length - 1] === 'self' && path.length > 1 ? path.slice(0, -1) : path;
      this.out.uses.push({ path: p, glob, pub, ...(alias ? { alias } : {}), modPath, test, line, text: this.detail ? squash(node.text()) : '' });
    });
  }

  methods(body: SgNode | null, owner: string, prefix: string, exportedBy: (vis: string | undefined) => boolean): void {
    for (const m of body?.children() ?? []) {
      if (m.kind() !== 'function_item' && m.kind() !== 'function_signature_item') continue;
      const name = m.field('name')?.text();
      if (!name) continue;
      const vis = m.children().find((c) => c.kind() === 'visibility_modifier')?.text();
      this.sym(`${prefix}${owner}::${name}`, 'method', exportedBy(vis), m, m, { container: `${prefix}${owner}` });
    }
  }

  walk(container: SgNode, modPath: string[], test: boolean): void {
    const prefix = modPath.length ? `${modPath.join('::')}::` : '';
    this.inTest = test;
    let attrs: SgNode[] = [];
    for (const node of container.children()) {
      const kind = String(node.kind());
      if (kind === 'attribute_item') { attrs.push(node); continue; }
      if (kind === 'line_comment' || kind === 'block_comment') continue;
      if (!node.isNamed()) continue;
      const mine = attrs;
      attrs = [];
      const attrText = mine.map((a) => a.text());
      const cfgTest = attrText.some((a) => /^#\[cfg\((.*\W)?test\W/.test(a));
      const first = mine[0] ?? node;
      const pub = node.children().find((c) => c.kind() === 'visibility_modifier')?.text() === 'pub';
      const name = node.field('name')?.text();
      if (kind === 'use_declaration') this.use(node, pub, modPath, test || cfgTest);
      else if (kind === 'mod_item' && name) {
        const body = node.field('body');
        const pathAttr = attrText.map((a) => /^#\[path\s*=\s*"([^"]+)"\s*\]/.exec(a)?.[1]).find(Boolean);
        this.out.mods.push({ name, ...(pathAttr ? { pathAttr } : {}), inline: !!body, modPath, test: test || cfgTest });
        if (body) {
          if (test || cfgTest) this.testRanges.push([node.range().start.index, node.range().end.index]);
          this.walk(body, [...modPath, name], test || cfgTest);
          this.inTest = test;
        } else this.sym(`${prefix}${name}`, 'module', pub, node, first);
      } else if (kind === 'impl_item') {
        const type = node.field('type')?.text();
        const trait = node.field('trait')?.text();
        if (!type) continue;
        const owner = baseType(type);
        if (trait) this.sym(`${prefix}impl ${squash(trait)} for ${squash(type)}`, 'trait-impl', true, node, first, { container: `${prefix}${owner}` });
        else this.methods(node.field('body'), owner, prefix, (vis) => vis === 'pub');
      } else if (kind === 'macro_definition' && name) {
        this.sym(`${prefix}${name}`, 'macro', attrText.some((a) => a.includes('macro_export')), node, first);
      } else if (ITEM_KIND[kind] && name) {
        this.sym(`${prefix}${name}`, ITEM_KIND[kind], pub, node, first);
        if (kind === 'trait_item') this.methods(node.field('body'), name, prefix, () => pub);
      }
    }
  }

  inlinePaths(root: SgNode): void {
    const seen = new Set<string>();
    for (const node of root.findAll({ rule: { any: [{ kind: 'scoped_identifier' }, { kind: 'scoped_type_identifier' }] } })) {
      const parent = node.parent()?.kind();
      if (parent === 'scoped_identifier' || parent === 'scoped_type_identifier' || parent === 'use_declaration' || parent === 'use_as_clause'
        || parent === 'use_wildcard' || parent === 'scoped_use_list' || parent === 'use_list') continue;
      const text = node.text().replace(/\s+/g, '');
      if (seen.has(text) || !/^[a-z_][a-z0-9_]*::/.test(text) || /^(std|core|alloc|self|super)::/.test(text) || text.includes('<')) continue;
      seen.add(text);
      const at = node.range().start.index;
      this.out.uses.push({
        path: segments(text), glob: false, pub: false, modPath: [], inline: true, line: node.range().start.line + 1, text,
        test: this.testRanges.some(([a, b]) => at >= a && at < b),
      });
    }
  }
}

export function parseRust(text: string, detail: boolean): ParsedRust {
  const root = parse('rust', text).root();
  const c = new Collector(detail);
  c.walk(root, [], false);
  if (text.includes('::')) c.inlinePaths(root);
  return c.out;
}
