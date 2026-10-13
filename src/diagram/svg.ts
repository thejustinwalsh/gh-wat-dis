import { ELEMENT_TYPES, STATUSES } from '../spec.ts';
import type { DiagramSpec, Detail } from '../spec.ts';
import { BADGE_PX, CYLINDER_RY, GROUP_KIND_PX, GROUP_NAME_PX, PIPE_RX, badgeWidth, layout } from './layout.ts';
import type { EdgePath, NodeBox, Pt } from './layout.ts';
import { escapeXml, fit, textWidth } from './measure.ts';
import { FONT, applyTheme } from './theme.ts';
import type { ThemeName } from './theme.ts';
import { STATUS_BADGE, STATUS_MARK, TYPE_LABEL, active, kindLine } from './vocab.ts';

const MARGIN = 24;
const HEADER = 62;
const MIN_WIDTH = 440;
const FILL: Record<string, string> = {
  person: 'person', system: 'system', container: 'container', component: 'component', datastore: 'store', queue: 'store',
};

const CSS = [
  `text{font-family:${FONT};fill:var(--fg)}`,
  '.bg{fill:var(--bg);stroke:var(--frame)}',
  '.title{font-size:18px;font-weight:600}.sub{font-size:12.5px;fill:var(--muted)}',
  '.nm{font-size:14px;font-weight:600;text-anchor:middle}.ty{font-size:11px;fill:var(--muted);text-anchor:middle}',
  '.ds{font-size:12px;text-anchor:middle}',
  `.gn{font-size:${GROUP_NAME_PX}px;font-weight:600}.gk{font-size:${GROUP_KIND_PX}px;font-weight:400;fill:var(--muted)}`,
  '.el{font-size:11.5px;font-weight:500;text-anchor:middle}.et{font-size:10px;fill:var(--muted);text-anchor:middle}',
  '.kh{font-size:10px;font-weight:600;letter-spacing:.08em;fill:var(--muted)}.kt{font-size:11.5px}',
  '.sh{stroke:var(--stroke);stroke-width:1.25;stroke-linejoin:round}',
  ...['person', 'system', 'container', 'component', 'store', 'external', 'group', 'bg'].map((f) => `.f-${f}{fill:var(--${f})}`),
  '.dt{fill:none}.grp{stroke-dasharray:6 4}.glyph{fill:var(--stroke)}',
  '.s-added{stroke:var(--added);stroke-width:3;stroke-dasharray:none}',
  '.s-changed{stroke:var(--changed);stroke-width:2.5;stroke-dasharray:9 5}',
  '.s-removed{stroke:var(--removed);stroke-width:2.5;stroke-dasharray:1.5 5.5;stroke-linecap:round}',
  '.s-affected{stroke:var(--affected);stroke-width:1.5;stroke-dasharray:none}',
  '.ring{fill:none;stroke:var(--affected);stroke-width:1.5}',
  '.gone{opacity:.72}.strike{stroke:var(--fg);stroke-width:1.2}',
  `.bt{font-size:${BADGE_PX}px;font-weight:700;letter-spacing:.03em;text-anchor:middle;fill:var(--on-status)}`,
  ...STATUSES.filter((s) => s !== 'unchanged').flatMap((s) => [`.b-${s}{fill:var(--${s})}`, `.m-${s}{fill:var(--${s});font-weight:700}`]),
  '.e{fill:none;stroke:var(--line);stroke-width:1.4;stroke-linejoin:round}.ah{fill:var(--line)}',
  '.e-added{stroke:var(--added);stroke-width:2.6}',
  '.e-changed{stroke:var(--changed);stroke-width:2;stroke-dasharray:8 5}',
  '.e-removed{stroke:var(--removed);stroke-width:2;stroke-dasharray:1.5 5;stroke-linecap:round}',
  '.e-affected{stroke:var(--affected);stroke-width:1.8;stroke-dasharray:12 4 2 4}',
  '.halo{fill:var(--bg);opacity:.94}.rule{stroke:var(--frame)}',
].join('');

const n = (v: number): string => String(Math.round(v * 10) / 10);

/** The outline of a leaf element. `small` is the key swatch. */
function shape(type: string, x: number, y: number, w: number, h: number, cls: string, small = false): string {
  const open = `<path class="${cls}" d="`, detail = `<path class="${cls} dt" d="`;
  if (type === 'datastore') {
    const ry = small ? 3 : CYLINDER_RY, rx = w / 2;
    return `${open}M${n(x)} ${n(y + ry)}A${n(rx)} ${ry} 0 0 1 ${n(x + w)} ${n(y + ry)}V${n(y + h - ry)}A${n(rx)} ${ry} 0 0 1 ${n(x)} ${n(y + h - ry)}Z"/>`
      + `${detail}M${n(x)} ${n(y + ry)}A${n(rx)} ${ry} 0 0 0 ${n(x + w)} ${n(y + ry)}"/>`;
  }
  if (type === 'queue') {
    const rx = small ? 4 : PIPE_RX, ry = h / 2;
    return `${open}M${n(x + rx)} ${n(y)}H${n(x + w - rx)}A${rx} ${n(ry)} 0 0 1 ${n(x + w - rx)} ${n(y + h)}H${n(x + rx)}A${rx} ${n(ry)} 0 0 1 ${n(x + rx)} ${n(y)}Z"/>`
      + `${detail}M${n(x + w - rx)} ${n(y)}A${rx} ${n(ry)} 0 0 0 ${n(x + w - rx)} ${n(y + h)}"/>`;
  }
  const r = type === 'person' ? (small ? 8 : 20) : small ? 3 : 7;
  return `<rect class="${cls}" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${r}"/>`;
}

const figure = (cx: number, top: number, s = 1): string =>
  `<circle class="glyph" cx="${n(cx)}" cy="${n(top + 6.5 * s)}" r="${n(6.5 * s)}"/>`
  + `<path class="glyph" d="M${n(cx - 11 * s)} ${n(top + 25 * s)}a${n(11 * s)} ${n(10 * s)} 0 0 1 ${n(22 * s)} 0z"/>`;

function badge(status: string, right: number, top: number): string {
  const w = badgeWidth(status);
  return `<rect class="b-${status}" x="${n(right - w)}" y="${n(top - 9)}" width="${n(w)}" height="18" rx="9"/>`
    + `<text class="bt" x="${n(right - w / 2)}" y="${n(top + 3.5)}">${escapeXml(STATUS_BADGE[status]!)}</text>`;
}

function drawGroup(b: NodeBox): string {
  const status = active(b.el.status);
  let out = `<rect class="sh grp f-${b.depth % 2 ? 'bg' : 'group'}${status ? ` s-${status}` : ''}" x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="9"/>`;
  if (status === 'affected') out += `<rect class="ring" x="${n(b.x - 4)}" y="${n(b.y - 4)}" width="${n(b.w + 8)}" height="${n(b.h + 8)}" rx="12"/>`;
  return status === 'removed' ? `<g class="gone">${out}</g>` : out;
}

/** Drawn above the edges, on a patch of the group's own fill, so a line that enters the group never strikes the text. */
function drawGroupLabel(b: NodeBox): string {
  const status = active(b.el.status);
  const x = b.x + 14, room = b.w - 28;
  const nameW = textWidth(b.el.name, GROUP_NAME_PX, true), kindW = textWidth(kindLine(b.el), GROUP_KIND_PX);
  const oneLine = nameW + 8 + kindW <= room;
  const name = fit(b.el.name, GROUP_NAME_PX, room, true), kind = fit(kindLine(b.el), GROUP_KIND_PX, room);
  const nameY = b.y + (oneLine ? 26 : 21);
  const w = oneLine ? nameW + 8 + kindW : Math.max(textWidth(name, GROUP_NAME_PX, true), textWidth(kind, GROUP_KIND_PX));
  let out = `<rect class="f-${b.depth % 2 ? 'bg' : 'group'}" x="${n(x - 4)}" y="${n(nameY - 14)}" width="${n(w + 8)}" height="${oneLine ? 20 : 31}" rx="3"/>`
    + `<text class="gn" x="${n(x)}" y="${n(nameY)}">${escapeXml(name)}`
    + (oneLine ? `<tspan class="gk" dx="8">${escapeXml(kind)}</tspan></text>` : `</text><text class="gk" x="${n(x)}" y="${n(nameY + 15)}">${escapeXml(kind)}</text>`);
  if (status === 'removed') out += `<path class="strike" d="M${n(x)} ${n(nameY - 4.5)}h${n(textWidth(name, GROUP_NAME_PX, true) / 1.08)}"/>`;
  return (status === 'removed' ? `<g class="gone">${out}</g>` : out) + (status ? badge(status, b.x + b.w - 12, b.y) : '');
}

function drawLeaf(b: NodeBox): string {
  const { el } = b;
  const status = active(el.status);
  const cx = b.x + b.w / 2;
  const fill = el.external ? 'external' : FILL[el.type] ?? 'container';
  let out = shape(el.type, b.x, b.y, b.w, b.h, `sh f-${fill}${status ? ` s-${status}` : ''}`);
  if (status === 'affected') out += `<rect class="ring" x="${n(b.x - 4)}" y="${n(b.y - 4)}" width="${n(b.w + 8)}" height="${n(b.h + 8)}" rx="${el.type === 'person' ? 24 : 11}"/>`;
  if (el.type === 'person') out += figure(cx, b.y + 9);
  for (const line of b.lines) {
    out += `<text class="${line.cls}" x="${n(cx)}" y="${n(b.y + line.dy)}">${escapeXml(line.text)}</text>`;
    if (status === 'removed' && line.cls === 'nm') {
      const half = textWidth(line.text, 14, true) / 1.08 / 2;
      out += `<path class="strike" d="M${n(cx - half)} ${n(b.y + line.dy - 4.5)}h${n(half * 2)}"/>`;
    }
  }
  return (status === 'removed' ? `<g class="gone">${out}</g>` : out) + (status ? badge(status, b.x + b.w - 10, b.y) : '');
}

const HEAD = 9;

/** An orthogonal polyline with rounded corners, stopped short of the tip so the arrowhead ends exactly on the border. */
function drawEdge(e: EdgePath, cls = ''): string {
  const pts = e.points.filter((p, i, all) => i === 0 || Math.hypot(p.x - all[i - 1]!.x, p.y - all[i - 1]!.y) > 0.01);
  if (pts.length < 2) return '';
  const tip = pts.at(-1)!, before = pts.at(-2)!;
  const len = Math.hypot(tip.x - before.x, tip.y - before.y);
  const ux = (tip.x - before.x) / len, uy = (tip.y - before.y) / len;
  const back = Math.min(HEAD - 2, len / 2);
  const line: Pt[] = [...pts.slice(0, -1), { x: tip.x - ux * back, y: tip.y - uy * back }];
  let d = `M${n(line[0]!.x)} ${n(line[0]!.y)}`;
  for (let i = 1; i < line.length; i++) {
    const p = line[i]!, prev = line[i - 1]!, next = line[i + 1];
    if (!next) { d += `L${n(p.x)} ${n(p.y)}`; break; }
    const a = Math.hypot(p.x - prev.x, p.y - prev.y), b = Math.hypot(next.x - p.x, next.y - p.y);
    const r = Math.min(7, a / 2, b / 2);
    d += `L${n(p.x - ((p.x - prev.x) / a) * r)} ${n(p.y - ((p.y - prev.y) / a) * r)}`
      + `Q${n(p.x)} ${n(p.y)} ${n(p.x + ((next.x - p.x) / b) * r)} ${n(p.y + ((next.y - p.y) / b) * r)}`;
  }
  const bx = tip.x - ux * HEAD, by = tip.y - uy * HEAD;
  const head = `M${n(tip.x)} ${n(tip.y)}L${n(bx - uy * 4.2)} ${n(by + ux * 4.2)}L${n(bx + uy * 4.2)} ${n(by - ux * 4.2)}z`;
  const status = cls || active(e.rel.status);
  return `<path class="e${status ? ` e-${status}` : ''}" d="${d}"/><path class="${status ? `b-${status}` : 'ah'}" d="${head}"/>`;
}

function drawLabel(e: EdgePath): string {
  const l = e.label;
  if (!l) return '';
  const status = active(e.rel.status);
  const cx = l.x + l.w / 2;
  let out = `<rect class="halo" x="${n(l.x)}" y="${n(l.y)}" width="${n(l.w)}" height="${n(l.h)}" rx="4"/>`;
  l.lines.forEach((line, i) => {
    const marked = i === 0 && status !== undefined;
    const body = marked
      ? `<tspan class="m-${status}">${escapeXml(STATUS_MARK[status]!)}</tspan>${escapeXml(line.text.slice(1))}`
      : escapeXml(line.text);
    out += `<text class="${line.cls}" x="${n(cx)}" y="${n(l.y + line.dy)}">${body}</text>`;
  });
  return out;
}

interface KeyItem { w: number; draw: (x: number, y: number) => string; label: string }

function keyItems(spec: DiagramSpec, boxes: NodeBox[], edges: EdgePath[]): KeyItem[] {
  const items: KeyItem[] = [];
  const leaves = boxes.filter((b) => !b.group);
  const sample = (x: number, y: number, status = ''): string =>
    drawEdge({ rel: { from: '', to: '', label: '' }, points: [{ x, y: y + 8 }, { x: x + 30, y: y + 8 }] }, status);
  for (const type of ELEMENT_TYPES) {
    if (!leaves.some((b) => b.el.type === type && !b.el.external)) continue;
    items.push({
      w: 26, label: TYPE_LABEL[type]!,
      draw: (x, y) => shape(type, x, y, 26, 16, `sh f-${FILL[type] ?? 'container'}`, true) + (type === 'person' ? figure(x + 13, y + 3, 0.42) : ''),
    });
  }
  if (leaves.some((b) => b.el.external)) {
    items.push({ w: 26, label: 'External', draw: (x, y) => shape('system', x, y, 26, 16, 'sh f-external', true) });
  }
  if (boxes.some((b) => b.group)) {
    items.push({ w: 26, label: 'Boundary', draw: (x, y) => `<rect class="sh grp f-group" x="${n(x)}" y="${n(y)}" width="26" height="16" rx="3"/>` });
  }
  if (edges.length) items.push({ w: 30, label: spec.type === 'dynamic' ? 'Numbered step' : 'Relationship', draw: (x, y) => sample(x, y) });
  for (const status of STATUSES) {
    if (status === 'unchanged') continue;
    const onNode = boxes.some((b) => b.el.status === status);
    const onEdge = edges.some((e) => e.rel.status === status);
    if (!onNode && !onEdge) continue;
    const title = STATUS_BADGE[status]!;
    items.push({
      w: (onNode ? 26 : 0) + (onNode && onEdge ? 6 : 0) + (onEdge ? 30 : 0),
      label: title[0] + title.slice(1).toLowerCase().replace(/^ ([a-z])/, (_, c: string) => ' ' + c.toUpperCase()),
      draw: (x, y) => {
        let out = '';
        if (onNode) {
          out += `<rect class="sh f-container s-${status}" x="${n(x + 2)}" y="${n(y + 2)}" width="22" height="12" rx="3"/>`;
          if (status === 'affected') out += `<rect class="ring" x="${n(x - 1)}" y="${n(y - 1)}" width="28" height="18" rx="5"/>`;
        }
        return out + (onEdge ? sample(x + (onNode ? 32 : 0), y, status) : '');
      },
    });
  }
  return items;
}

function describe(spec: DiagramSpec, subtitle: string): string {
  const name = new Map(spec.elements.map((e) => [e.id, e.name]));
  const els = spec.elements.map((e) => {
    const status = active(e.status);
    return `${e.name} (${e.external ? 'external ' : ''}${(TYPE_LABEL[e.type] ?? e.type).toLowerCase()}${status ? `, ${status}` : ''})`;
  });
  const rels = spec.relationships.map((r) => {
    const status = active(r.status);
    return `${name.get(r.from) ?? r.from} to ${name.get(r.to) ?? r.to}: ${r.order !== undefined ? `${r.order}. ` : ''}${r.label}${status ? ` (${status})` : ''}`;
  });
  return `${subtitle}. ${els.length} elements: ${els.join(', ')}. ${rels.length} relationships: ${rels.join('; ')}.`;
}

export async function renderSvg(spec: DiagramSpec, opts: { theme?: ThemeName; detail?: Detail } = {}): Promise<string> {
  const g = await layout(spec, { detail: opts.detail });
  const kind = spec.type[0]!.toUpperCase() + spec.type.slice(1);
  const subtitle = `${kind} diagram${spec.scope ? ` for ${spec.scope}` : ''}`;
  const width = Math.ceil(Math.max(g.width, textWidth(spec.title, 18, true), textWidth(subtitle, 12.5), MIN_WIDTH) + 2 * MARGIN);
  const ox = Math.round((width - g.width) / 2), oy = HEADER + 22;

  const groups = g.nodes.filter((b) => b.group).sort((a, b) => a.depth - b.depth);
  const body = [
    ...groups.map(drawGroup),
    ...g.edges.map((e) => drawEdge(e)),
    ...groups.map(drawGroupLabel),
    ...g.nodes.filter((b) => !b.group).map(drawLeaf),
    ...g.edges.map(drawLabel),
  ].join('');

  const keyTop = oy + g.height + 26;
  let x = MARGIN, y = keyTop + 30, key = '';
  for (const item of keyItems(spec, g.nodes, g.edges)) {
    const w = item.w + 7 + textWidth(item.label, 11.5) + 20;
    if (x > MARGIN && x + w - 20 > width - MARGIN) { x = MARGIN; y += 26; }
    key += item.draw(x, y) + `<text class="kt" x="${n(x + item.w + 7)}" y="${n(y + 12)}">${escapeXml(item.label)}</text>`;
    x += w;
  }
  const height = Math.ceil(y + 16 + MARGIN - 4);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="dg-title dg-desc">`
    + `<title id="dg-title">${escapeXml(`${spec.title}: ${subtitle}`)}</title>`
    + `<desc id="dg-desc">${escapeXml(describe(spec, subtitle))}</desc>`
    + `<style>${applyTheme(CSS, opts.theme ?? 'auto')}</style>`
    + `<rect class="bg" x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12"/>`
    + `<text class="title" x="${MARGIN}" y="${MARGIN + 20}">${escapeXml(spec.title)}</text>`
    + `<text class="sub" x="${MARGIN}" y="${MARGIN + 40}">${escapeXml(subtitle)}</text>`
    + `<g transform="translate(${ox} ${oy})">${body}</g>`
    + `<path class="rule" d="M${MARGIN} ${n(keyTop)}H${width - MARGIN}"/>`
    + `<text class="kh" x="${MARGIN}" y="${n(keyTop + 18)}">KEY</text>${key}`
    + '</svg>\n';
}
