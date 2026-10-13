import { ELEMENT_TYPES, STATUSES } from '../spec.ts';
import type { DiagramSpec } from '../spec.ts';
import {
  BADGE_PX, CARD_DIR_PX, CARD_KIND_PX, CARD_NAME_X, CARD_PAD, CARD_PATH_PX, CARD_SYMBOL_PX, CYLINDER_RY, GROUP_KIND_PX, GROUP_NAME_PX, GROUP_PAD_X,
  LANE_NAME_PX, PIPE_RX, groupLabelWidth,
} from './layout.ts';
import type { EdgePath, NodeBox, Pt, Rect } from './layout.ts';
import { escapeXml, fit, monoWidth, textWidth, wrap } from './measure.ts';
import { FONT, MONO, applyTheme } from './theme.ts';
import { judge } from './fit.ts';
import type { FitOptions, Report } from './fit.ts';
import type { ThemeName } from './theme.ts';
import { STATUS_BADGE, STATUS_MARK, STATUS_WORD, TYPE_LABEL, active, kindLine, relText } from './vocab.ts';

const MARGIN = 24;
const HEADER = 62;
const MIN_WIDTH = 440;
/** The title and the scope line wrap at the width of the drawing, and no narrower than this. */
const HEAD_WRAP = 700;
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
  `.fd{font-size:${CARD_PATH_PX}px;fill:var(--muted)}.fs{font-size:${CARD_DIR_PX}px;fill:var(--muted)}.fb{font-size:${CARD_PATH_PX}px;font-weight:600;fill:var(--fg)}.fn{font-size:11px;fill:var(--muted)}`,
  `.sy{font-family:${MONO};font-size:${CARD_SYMBOL_PX}px}.sk{font-size:${CARD_KIND_PX}px;fill:var(--muted);text-anchor:end}`,
  '.sm{font-size:13px;text-anchor:middle}.card{stroke:var(--stroke);stroke-width:1}',
  `.lane{fill:var(--group)}.ln{font-size:${LANE_NAME_PX}px;font-weight:600;letter-spacing:.06em;fill:var(--muted)}`,
  '.num{fill:var(--bg);stroke:var(--line);stroke-width:1.2}.en{font-size:11px;font-weight:700;text-anchor:middle}',
  '.n-added{stroke:var(--added);stroke-width:2}.n-changed{stroke:var(--changed);stroke-width:2}.n-removed{stroke:var(--removed);stroke-width:2}.n-affected{stroke:var(--affected);stroke-width:2}',
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

/** The status in words, inside the element, where `layout` found room for it. */
function badge(status: string, r: Rect | undefined): string {
  if (!r) return '';
  return `<rect class="b-${status}" x="${n(r.x)}" y="${n(r.y)}" width="${n(r.w)}" height="${n(r.h)}" rx="${n(r.h / 2)}"/>`
    + `<text class="bt" x="${n(r.x + r.w / 2)}" y="${n(r.y + r.h / 2 + 3.4)}">${escapeXml(STATUS_BADGE[status]!)}</text>`;
}

function drawGroup(b: NodeBox): string {
  if (b.light) return `<rect class="lane" x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="8"/>`;
  const status = active(b.el.status);
  let out = `<rect class="sh grp f-${b.depth % 2 ? 'bg' : 'group'}${status ? ` s-${status}` : ''}" x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="9"/>`;
  if (status === 'affected') out += `<rect class="ring" x="${n(b.x - 4)}" y="${n(b.y - 4)}" width="${n(b.w + 8)}" height="${n(b.h + 8)}" rx="12"/>`;
  return status === 'removed' ? `<g class="gone">${out}</g>` : out;
}

/** Drawn above the edges, on a patch of the group's own fill, so a line that enters the group never strikes the text. */
function drawGroupLabel(b: NodeBox): string {
  if (b.light) return `<text class="ln" x="${n(b.title?.x ?? b.x + 10)}" y="${n(b.y + 18)}">${escapeXml(fit(b.el.name, LANE_NAME_PX, (b.w - 20) / 1.06, true).toUpperCase())}</text>`;
  const status = active(b.el.status);
  // `layout` makes a group wide enough for its label, so the two-line and cut forms are a last resort.
  const room = b.w - 2 * GROUP_PAD_X - (b.badge ? b.badge.w + 10 : 0);
  const oneLine = groupLabelWidth(b.el) <= room;
  const x = oneLine ? b.title?.x ?? b.x + GROUP_PAD_X : b.x + GROUP_PAD_X;
  const name = fit(b.el.name, GROUP_NAME_PX, room, true), kind = fit(kindLine(b.el), GROUP_KIND_PX, room);
  const nameY = b.y + (oneLine ? 26 : 21);
  const w = oneLine ? groupLabelWidth(b.el) : Math.max(textWidth(name, GROUP_NAME_PX, true), textWidth(kind, GROUP_KIND_PX));
  let out = `<rect class="f-${b.depth % 2 ? 'bg' : 'group'}" x="${n(x - 4)}" y="${n(nameY - 14)}" width="${n(w + 8)}" height="${oneLine ? 20 : 31}" rx="3"/>`
    + `<text class="gn" x="${n(x)}" y="${n(nameY)}">${escapeXml(name)}`
    + (oneLine ? `<tspan class="gk" dx="8">${escapeXml(kind)}</tspan></text>` : `</text><text class="gk" x="${n(x)}" y="${n(nameY + 15)}">${escapeXml(kind)}</text>`);
  if (status === 'removed') out += `<path class="strike" d="M${n(x)} ${n(nameY - 4.5)}h${n(textWidth(name, GROUP_NAME_PX, true) / 1.08)}"/>`;
  return (status === 'removed' ? `<g class="gone">${out}</g>` : out) + (status ? badge(status, b.badge) : '');
}

/** A status mark: the same sign in the same colour on a file, on a symbol and in the key. */
const mark = (status: string, x: number, y: number): string =>
  `<text class="sm m-${status}" x="${n(x)}" y="${n(y)}">${escapeXml(STATUS_MARK[status]!)}</text>`;

/** A file card: the path, a rule, then one row for each symbol with its mark, its name and its kind. */
function drawFile(b: NodeBox): string {
  const card = b.card!;
  const status = active(b.el.status);
  const x = b.x + CARD_PAD + (status ? 15 : 0), headY = b.y + (card.stacked ? card.head - 11 : card.head / 2 + 4);
  let out = `<rect class="card f-bg" x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="6"/>`;
  if (card.lane) out += `<text class="ln" x="${n(b.title?.x ?? b.x + 2)}" y="${n(b.y - 6)}">${escapeXml(fit(card.lane, LANE_NAME_PX, b.w / 1.06 - 4, true).toUpperCase())}</text>`;
  if (status) out += mark(status, b.x + CARD_PAD + 4, headY + 0.5);
  out += card.stacked
    ? `<text class="fs" x="${n(x)}" y="${n(headY - 15)}">${escapeXml(card.dir)}</text><text class="fb" x="${n(x)}" y="${n(headY)}">${escapeXml(card.base)}</text>`
    : `<text class="fd" x="${n(x)}" y="${n(headY)}">${escapeXml(card.dir)}<tspan class="fb">${escapeXml(card.base)}</tspan></text>`;
  if (status === 'removed') out += `<path class="strike" d="M${n(x)} ${n(headY - 4)}h${n(((card.stacked ? 0 : textWidth(card.dir, CARD_PATH_PX)) + textWidth(card.base, CARD_PATH_PX, true)) / 1.08)}"/>`;
  if (card.rows.length || card.note) out += `<path class="rule" d="M${n(b.x)} ${n(b.y + card.head)}h${n(b.w)}"/>`;
  for (const row of card.rows) {
    const y = b.y + row.dy + 4;
    let line = `<text class="sy" x="${n(b.x + CARD_NAME_X)}" y="${n(y)}">${escapeXml(row.name)}</text>`;
    if (row.kind) line += `<text class="sk" x="${n(b.x + b.w - CARD_PAD)}" y="${n(y)}">${escapeXml(row.kind)}</text>`;
    if (row.status === 'removed') line = `<g class="gone">${line}<path class="strike" d="M${n(b.x + CARD_NAME_X)} ${n(y - 4)}h${n(monoWidth(row.name, CARD_SYMBOL_PX) / 1.08)}"/></g>`;
    out += (row.status ? mark(row.status, b.x + CARD_PAD + 4, y + 0.5) : '') + line;
  }
  if (card.note) out += `<text class="fn" x="${n(b.x + CARD_PAD)}" y="${n(b.y + card.note.dy + 4)}">${escapeXml(card.note.text)}</text>`;
  return out;
}

function drawLeaf(b: NodeBox): string {
  if (b.card) return drawFile(b);
  const { el } = b;
  const status = active(el.status);
  const cx = b.x + b.w / 2;
  const fill = el.external ? 'external' : FILL[el.type] ?? 'container';
  let out = shape(el.type, b.x, b.y, b.w, b.h, `sh f-${fill}${status ? ` s-${status}` : ''}`);
  if (status === 'affected') out += `<rect class="ring" x="${n(b.x - 4)}" y="${n(b.y - 4)}" width="${n(b.w + 8)}" height="${n(b.h + 8)}" rx="${el.type === 'person' ? 24 : 11}"/>`;
  // In a narrow box the figure moves left to leave the corner to the badge.
  if (el.type === 'person') out += figure(b.badge ? Math.min(cx, b.badge.x - 19) : cx, b.y + 9);
  for (const line of b.lines) {
    out += `<text class="${line.cls}" x="${n(cx)}" y="${n(b.y + line.dy)}">${escapeXml(line.text)}</text>`;
    if (status === 'removed' && line.cls === 'nm') {
      const half = textWidth(line.text, 14, true) / 1.08 / 2;
      out += `<path class="strike" d="M${n(cx - half)} ${n(b.y + line.dy - 4.5)}h${n(half * 2)}"/>`;
    }
  }
  return (status === 'removed' ? `<g class="gone">${out}</g>` : out) + (status ? badge(status, b.badge) : '');
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
  if (l.lines[0]?.cls === 'en') {
    return `<rect class="num${status ? ` n-${status}` : ''}" x="${n(l.x)}" y="${n(l.y)}" width="${n(l.w)}" height="${n(l.h)}" rx="10"/>`
      + `<text class="en" x="${n(cx)}" y="${n(l.y + 14)}">${escapeXml(l.lines[0].text)}</text>`;
  }
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

function keyItems(spec: DiagramSpec, boxes: NodeBox[], edges: EdgePath[], numbered: boolean): KeyItem[] {
  const items: KeyItem[] = [];
  const leaves = boxes.filter((b) => !b.group);
  const sample = (x: number, y: number, status = ''): string =>
    drawEdge({ rel: { from: '', to: '', label: '' }, points: [{ x, y: y + 8 }, { x: x + 30, y: y + 8 }] }, status);
  for (const type of ELEMENT_TYPES) {
    if (!leaves.some((b) => b.el.type === type && !b.el.external)) continue;
    if (type === 'file') {
      items.push({ w: 26, label: 'File', draw: (x, y) => `<rect class="card f-bg" x="${n(x)}" y="${n(y)}" width="26" height="16" rx="3"/><path class="rule" d="M${n(x)} ${n(y + 6)}h26"/>` });
      continue;
    }
    items.push({
      w: 26, label: TYPE_LABEL[type]!,
      draw: (x, y) => shape(type, x, y, 26, 16, `sh f-${FILL[type] ?? 'container'}`, true) + (type === 'person' ? figure(x + 13, y + 3, 0.42) : ''),
    });
  }
  if (leaves.some((b) => b.el.external)) {
    items.push({ w: 26, label: 'External', draw: (x, y) => shape('system', x, y, 26, 16, 'sh f-external', true) });
  }
  if (boxes.some((b) => b.group && !b.light)) {
    items.push({ w: 26, label: 'Boundary', draw: (x, y) => `<rect class="sh grp f-group" x="${n(x)}" y="${n(y)}" width="26" height="16" rx="3"/>` });
  }
  if (boxes.some((b) => b.light)) {
    items.push({ w: 26, label: 'Part of the system', draw: (x, y) => `<rect class="lane" x="${n(x)}" y="${n(y)}" width="26" height="16" rx="3"/>` });
  }
  if (boxes.some((b) => b.card?.lane)) {
    items.push({ w: 36, label: 'Part of the system', draw: (x, y) => `<text class="ln" x="${n(x)}" y="${n(y + 12)}">NAME</text>` });
  }
  const imports = edges.some((e) => !e.rel.label?.trim());
  if (edges.some((e) => e.rel.label?.trim())) items.push({ w: 30, label: spec.type === 'dynamic' ? 'Numbered step' : numbered ? 'Relationship, numbered in the table' : 'Relationship', draw: (x, y) => sample(x, y) });
  if (imports) items.push({ w: 30, label: 'Imports', draw: (x, y) => sample(x, y) });
  for (const status of STATUSES) {
    if (status === 'unchanged') continue;
    const onNode = boxes.some((b) => !b.card && b.el.status === status);
    const onEdge = edges.some((e) => e.rel.status === status);
    // A file and its symbols carry the status as a mark, so the key shows the mark.
    if (!onNode && !onEdge && boxes.some((b) => b.card && (b.el.status === status || b.card.rows.some((r) => r.status === status)))) {
      // On a file outside the diff the dot has one meaning, and the key says it.
      items.push({ w: 10, label: status === 'affected' ? 'Imports a changed signature' : STATUS_WORD[status]!, draw: (x, y) => mark(status, x + 5, y + 12.5) });
      continue;
    }
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
    const symbols = (e.symbols ?? []).map((s) => `${active(s.status) ? `${active(s.status)} ` : ''}${s.name}`);
    return `${e.name} (${e.external ? 'external ' : ''}${(TYPE_LABEL[e.type] ?? e.type).toLowerCase()}${status ? `, ${status}` : ''}${symbols.length ? `: ${symbols.join(', ')}` : ''})`;
  });
  const rels = spec.relationships.map((r) => {
    const status = active(r.status);
    return `${name.get(r.from) ?? r.from} to ${name.get(r.to) ?? r.to}: ${r.order !== undefined ? `${r.order}. ` : ''}${relText(r)}${status ? ` (${status})` : ''}`;
  });
  return `${subtitle}. ${els.length} elements: ${els.join(', ')}. ${rels.length} relationships: ${rels.join('; ')}.`;
}

export interface RenderOptions extends FitOptions { theme?: ThemeName }
export interface Rendered { svg: string; width: number; height: number; direction: 'DOWN' | 'RIGHT'; numbered: boolean; compact: boolean; report: Report }

export async function renderSvg(spec: DiagramSpec, opts: RenderOptions = {}): Promise<string> {
  return (await render(spec, opts)).svg;
}

export async function render(spec: DiagramSpec, opts: RenderOptions = {}): Promise<Rendered> {
  const { layout: g, report } = await judge(spec, opts);
  const kind = spec.type[0]!.toUpperCase() + spec.type.slice(1);
  const subtitle = `${kind} diagram${spec.scope ? ` for ${spec.scope}` : ''}`;
  // A long title or scope line wraps, so it never makes the image wider than the page.
  const room = Math.max(g.width, HEAD_WRAP);
  const titleLines = wrap(spec.title, 18, room, true), subLines = wrap(subtitle, 12.5, room);
  const headWidth = Math.max(...titleLines.map((l) => textWidth(l, 18, true)), ...subLines.map((l) => textWidth(l, 12.5)));
  const width = Math.ceil(Math.max(g.width, headWidth, MIN_WIDTH) + 2 * MARGIN);
  const subTop = (titleLines.length - 1) * 24, extra = subTop + (subLines.length - 1) * 17;
  const ox = Math.round((width - g.width) / 2), oy = HEADER + 22 + extra;

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
  for (const item of keyItems(spec, g.nodes, g.edges, g.numbered)) {
    const w = item.w + 7 + textWidth(item.label, 11.5) + 20;
    if (x > MARGIN && x + w - 20 > width - MARGIN) { x = MARGIN; y += 26; }
    key += item.draw(x, y) + `<text class="kt" x="${n(x + item.w + 7)}" y="${n(y + 12)}">${escapeXml(item.label)}</text>`;
    x += w;
  }
  const height = Math.ceil(y + 16 + MARGIN - 4);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="dg-title dg-desc">`
    + `<title id="dg-title">${escapeXml(`${spec.title}: ${subtitle}`)}</title>`
    + `<desc id="dg-desc">${escapeXml(describe(spec, subtitle))}</desc>`
    + `<style>${applyTheme(CSS, opts.theme ?? 'auto')}</style>`
    + `<rect class="bg" x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12"/>`
    + titleLines.map((l, i) => `<text class="title" x="${MARGIN}" y="${MARGIN + 20 + i * 24}">${escapeXml(l)}</text>`).join('')
    + subLines.map((l, i) => `<text class="sub" x="${MARGIN}" y="${MARGIN + 40 + subTop + i * 17}">${escapeXml(l)}</text>`).join('')
    + `<g transform="translate(${ox} ${oy})">${body}</g>`
    + `<path class="rule" d="M${MARGIN} ${n(keyTop)}H${width - MARGIN}"/>`
    + `<text class="kh" x="${MARGIN}" y="${n(keyTop + 18)}">KEY</text>${key}`
    + '</svg>\n';
  return { svg, width, height, direction: g.direction, numbered: g.numbered, compact: g.compact, report };
}
