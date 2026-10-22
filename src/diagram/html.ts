import type { DiagramSpec } from '../spec.ts';
import { relNumber } from './layout.ts';
import { escapeXml } from './measure.ts';
import { render, relationshipIds } from './svg.ts';
import type { Rendered, RenderOptions } from './svg.ts';
import { FONT, PALETTES } from './theme.ts';
import { active, relText } from './vocab.ts';

function legend(spec: DiagramSpec): string {
  const names = new Map(spec.elements.map((e) => [e.id, e.name]));
  const ids = relationshipIds(spec);
  const anyStatus = spec.relationships.some((r) => active(r.status));
  const head = ['#', 'From', 'To', 'What', 'How', ...(anyStatus ? ['Change'] : [])];
  const rows = spec.relationships.map((r, i) => ({ r, id: ids[i]! }))
    .sort((a, b) => relNumber(spec, a.r) - relNumber(spec, b.r))
    .map(({ r, id }) => {
      const cells = [String(relNumber(spec, r)), names.get(r.from) ?? r.from, names.get(r.to) ?? r.to, relText(r), r.technology ?? '', ...(anyStatus ? [active(r.status) ?? ''] : [])];
      return `<tr data-relationship-id="${id}">${cells.map((cell, i) => `<${i ? 'td' : 'th scope="row"'}>${escapeXml(cell)}</${i ? 'td' : 'th'}>`).join('')}</tr>`;
    }).join('');
  return `<div class="relationship-table"><table><caption>Relationships</caption><thead><tr>${head.map((text) => `<th scope="col">${text}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** Build a standalone page from render(spec, { ...opts, structured: true }) without drawing twice. */
export function renderHtmlDocument(spec: DiagramSpec, out: Rendered, opts: RenderOptions = {}): string {
  if (!out.structured) throw new Error('HTML needs a structured SVG: call render with structured: true');
  const theme = opts.theme ?? 'auto';
  if (theme !== 'auto' && theme !== 'light' && theme !== 'dark') throw new Error('HTML theme must be auto, light or dark');
  const palette = PALETTES[opts.palette ?? 'github'];
  const variables = (side: 'light' | 'dark'): string => {
    const p = palette[side];
    return `--page-bg:${p.bg};--page-fg:${p.fg};--page-muted:${p.muted};--page-frame:${p.frame}`;
  };
  const colours = `:root{color-scheme:${theme === 'auto' ? 'light dark' : theme};${variables(theme === 'dark' ? 'dark' : 'light')}}`
    + (theme === 'auto' ? `@media (prefers-color-scheme:dark){:root{${variables('dark')}}}` : '');
  const description = `${spec.type[0]!.toUpperCase() + spec.type.slice(1)} diagram${spec.scope ? ` for ${spec.scope}` : ''}.`;
  return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + `<title>${escapeXml(spec.title)}</title>\n<style>${colours}`
    + `*{box-sizing:border-box}body{margin:0;background:var(--page-bg);color:var(--page-fg);font-family:${FONT};line-height:1.5}`
    + 'main{max-width:1120px;margin:auto;padding:clamp(12px,3vw,32px)}h1{font-size:1.5rem;overflow-wrap:anywhere}figure{margin:0;min-width:0}'
    + '.diagram-viewport{max-width:100%;overflow:auto;border-radius:12px}.diagram-viewport:focus-visible{outline:2px solid var(--page-fg);outline-offset:3px}'
    + `#dg-svg{display:block;width:${out.width}px;height:auto;max-width:none}`
    + 'figcaption{margin:12px 0;color:var(--page-muted);overflow-wrap:anywhere}.relationship-table{overflow-x:auto}table{width:100%;border-collapse:collapse;text-align:left;font-size:.95rem}'
    + 'caption{text-align:left;font-weight:600;margin:20px 0 8px}th,td{padding:8px 12px;border:1px solid var(--page-frame);vertical-align:top;overflow-wrap:anywhere}'
    + '</style>\n</head>\n<body>\n<main>\n'
    + `<h1>${escapeXml(spec.title)}</h1>\n<figure aria-labelledby="diagram-caption">\n`
    + `<div class="diagram-viewport" role="region" aria-label="Diagram. Scroll horizontally to see the full drawing on a narrow screen." tabindex="0">${out.svg}</div>\n`
    + `<figcaption id="diagram-caption">${escapeXml(description)}</figcaption>\n</figure>\n`
    + (out.numbered ? legend(spec) + '\n' : '')
    + '</main>\n</body>\n</html>\n';
}

/** One self-contained HTML page, with an inline SVG and a table for numbered relationships. */
export async function renderHtml(spec: DiagramSpec, opts: RenderOptions = {}): Promise<string> {
  return renderHtmlDocument(spec, await render(spec, { ...opts, structured: true }), opts);
}
