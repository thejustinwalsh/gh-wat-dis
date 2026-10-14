// A backstop, not a style guide. It catches what GitHub would break and what is grossly
// off-shape. Wording, section choice and length are the skills' job: see skills/wat/references.

const KINDS = ['issue', 'pr', 'milestone', 'comment'] as const;
export type Kind = (typeof KINDS)[number];
export interface Finding { line: number; msg: string }
export interface BodyLint { errors: Finding[]; warnings: Finding[] }
interface Line { n: number; t: string; kind: 'text' | 'blank' | 'heading' | 'code' | 'fence' | 'end'; lang?: string; inDetails: boolean }
const MAX_CHARS = 60000;
const GROSS_LINES: Record<Kind, number> = { issue: 150, pr: 200, milestone: 40, comment: 80 };
const GROSS_CODE_LINES = 40;
const SAFE_MERMAID = ['flowchart', 'graph', 'sequenceDiagram', 'classDiagram', 'stateDiagram', 'stateDiagram-v2', 'erDiagram', 'gantt', 'pie', 'gitGraph'];
const AGENT_SUMMARY = /<summary>\s*(?:🤖\s*)?Agent context\s*<\/summary>/i;
const CLOSING = /^(close[sd]?|fix(e[sd])?|resolve[sd]?|refs?|part of|follow[- ]up(?: to)?)\s+((\S+\/\S+)?#\d+|https:\/\/\S+)(\s*,\s*((\S+\/\S+)?#\d+|https:\/\/\S+))*\.?$/i;

function scan(text: string): Line[] {
  const lines = text.split('\n');
  const out: Line[] = [];
  let fence: { ch: string; len: number } | null = null;
  let details = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    const f = t.match(/^(`{3,}|~{3,})(.*)$/);
    let kind: Line['kind'] = 'text';
    let lang: string | undefined;
    if (fence) {
      kind = 'code';
      if (f && f[1]![0] === fence.ch && f[1]!.length >= fence.len && !f[2]!.trim()) { fence = null; kind = 'fence'; }
    } else if (f) {
      fence = { ch: f[1]![0]!, len: f[1]!.length };
      kind = 'fence';
      lang = f[2]!.trim().split(/\s+/)[0];
    } else {
      details += (t.match(/<details\b/gi) ?? []).length;
      if (t === '') kind = 'blank';
      else if (/^#{1,6}\s/.test(t)) kind = 'heading';
    }
    out.push({ n: i + 1, t, kind, lang, inDetails: details > 0 });
    if (kind !== 'code' && kind !== 'fence') details = Math.max(0, details - (t.match(/<\/details>/gi) ?? []).length);
  }
  return out;
}

export function lintBody(text: string, { kind = 'issue', exists }: { kind?: Kind; exists?: (path: string) => boolean } = {}): BodyLint {
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
  const errors: Finding[] = [], warnings: Finding[] = [];
  const err = (line: number, msg: string): void => { errors.push({ line, msg }); };
  const warn = (line: number, msg: string): void => { warnings.push({ line, msg }); };
  const L = scan(text);
  const md = L.filter((l) => l.kind !== 'code' && l.kind !== 'fence');
  const visible = L.filter((l) => !l.inDetails);

  const first = L.find((l) => l.kind !== 'blank');
  if (!first) { err(0, 'body is empty'); return { errors, warnings }; }

  const chars = [...text].length;
  if (chars > MAX_CHARS) err(0, `body is ${chars} characters. GitHub rejects bodies over 65,536. Stay under ${MAX_CHARS}.`);

  if (first.kind === 'heading' && kind !== 'comment') warn(first.n, 'body opens with a heading. Open with a sentence that states the problem and the solution.');

  for (const l of md) {
    if (/<svg\b/i.test(l.t)) err(l.n, 'GitHub strips inline <svg>. Attach the file with gh --attach.');
    if (/\]\(data:|src=["']data:/i.test(l.t)) err(l.n, 'GitHub strips data: URIs. Attach the file with gh --attach.');
    for (const m of l.t.matchAll(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g)) {
      if (!m[1]!.trim()) warn(l.n, 'image has no alt text. Use the diagram title.');
      const target = m[2]!;
      const local = !/^(https?:)?\/\//.test(target) && !target.startsWith('../');
      if (local && exists && !exists(target)) err(l.n, `image file "${target}" does not exist next to the body. gh --attach has nothing to upload.`);
    }
  }
  // A diagram on a line of its own is centred: <div align="center">, a blank line, the image, a blank line, </div>.
  const OPEN = /^\s*<div\s+align=["']center["']\s*>\s*$/i;
  const CLOSE = /^\s*<\/div>\s*$/i;
  L.forEach((l, i) => {
    if (kind === 'milestone') return; // no image belongs in a milestone description: see below
    if (l.kind === 'code' || l.kind === 'fence' || !/^\s*!\[[^\]]*\]\([^)]+\)\s*$/.test(l.t)) return;
    const before = L[i - 1];
    const after = L[i + 1];
    if ((before && OPEN.test(before.t)) || (after && CLOSE.test(after.t))) {
      err(l.n, 'leave a blank line between <div align="center"> and the image, and between the image and </div>. GitHub does not render the image without them.');
      return;
    }
    const prev = L.slice(0, i).reverse().find((x) => x.kind !== 'blank');
    const next = L.slice(i + 1).find((x) => x.kind !== 'blank');
    if (!(prev && OPEN.test(prev.t) && next && CLOSE.test(next.t))) {
      warn(l.n, 'this image is not centred. Wrap it: <div align="center">, a blank line, the image, a blank line, </div>.');
    }
  });
  for (const l of L) {
    if (l.kind === 'fence' && l.lang === 'mermaid') {
      const type = (L[l.n]?.t ?? '').split(/\s+/)[0];
      if (type && !SAFE_MERMAID.includes(type)) warn(l.n + 1, `Mermaid "${type}" may not render on GitHub. Safe types: ${SAFE_MERMAID.join(', ')}.`);
    }
  }

  if (kind === 'milestone') {
    // What GitHub does with a milestone description was read from its pages: see "Milestone" in
    // skills/wat/references/formats.md. The milestone page renders Markdown. The milestones list prints
    // the source as one run of plain text, so every block element shows there as its raw characters.
    const LIST = 'The milestones list prints the description as plain text';
    for (const l of L) {
      if (l.kind === 'fence' && l.lang === 'mermaid') err(l.n, `${LIST}, and no milestone was found that draws Mermaid. Put the diagram in the tracking issue.`);
      if (l.kind === 'code' || l.kind === 'fence') continue;
      if (/^>\s*\[!/.test(l.t)) err(l.n, `${LIST}, so an alert shows there as "> [!NOTE]". State the caveat as a sentence, or put the alert in the tracking issue.`);
      if (/<details|<picture|<img|<div|<table/i.test(l.t)) err(l.n, `${LIST}, so an HTML block shows there as its tags. Put it in the tracking issue.`);
      if (/!\[[^\]]*\]\(/.test(l.t)) err(l.n, `${LIST}, and gh uploads no attachment for a milestone. Put the diagram in the tracking issue.`);
      if (l.kind === 'heading') warn(l.n, `${LIST}, so a heading shows there as "${l.t.match(/^#+/)![0]} ...". Use a bold label on its own line: **Done when**.`);
      if (/^[-*+]\s+\[[ xX]\]\s/.test(l.t)) warn(l.n, 'a task list in a milestone description renders as boxes nobody can tick, and counts toward no progress. Use a plain list: progress comes from the issues in the milestone.');
      if (/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(l.t) && l.t.includes('|')) warn(l.n, `${LIST}, so a table shows there as pipes and dashes. Use a list, or put the table in the tracking issue.`);
    }
  } else {
    const alerts = visible.filter((l) => /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(l.t));
    if (alerts.length > 2) warn(alerts[2]!.n, `${alerts.length} alerts. Readers skip a wall of alerts. Keep the one that blocks or breaks.`);

    const sums = md.filter((l) => AGENT_SUMMARY.test(l.t));
    if (sums.length > 1) err(sums[1]!.n, 'more than one "Agent context" block. Keep one, last.');
    if (sums.length) {
      const first0 = sums[0]!;
      const openIdx = L.indexOf(first0);
      let start = openIdx;
      while (start >= 0 && !/<details\b/i.test(L[start]!.t)) start--;
      let depth = 0, close = -1;
      for (let i = Math.max(start, 0); i < L.length; i++) {
        const li = L[i]!;
        if (li.kind === 'code' || li.kind === 'fence') continue;
        depth += (li.t.match(/<details\b/gi) ?? []).length;
        depth -= (li.t.match(/<\/details>/gi) ?? []).length;
        if (depth <= 0 && /<\/details>/i.test(li.t)) { close = i; break; }
      }
      if (start < 0 || close < 0) err(first0.n, '"Agent context" block is not a closed <details> element');
      else {
        const after = L.slice(close + 1).find((l) => l.kind !== 'blank' && !CLOSING.test(l.t));
        if (after) err(after.n, '"Agent context" must be the last block. Only a closing line such as "Closes #12" may follow it.');
      }
      if (start >= 0 && close >= 0 && !L.slice(start, close).some((l) => l.kind === 'fence')) {
        warn(first0.n, '"Agent context" holds no code block. GitHub shows a copy button only on a code block: put the content in one fenced block.');
      }
      if (start >= 0 && close >= 0) {
        const inner = L.slice(openIdx + 1, close);
        const fences = inner.filter((l) => l.kind === 'fence').length;
        const loose = inner.find((l) => l.kind === 'text' || l.kind === 'heading');
        if (fences > 2) warn(first0.n, '"Agent context" holds more than one code block. An agent copies one block: merge them into one fenced `text` block.');
        else if (fences && loose) warn(loose.n, '"Agent context" has text outside its code block. That text is not copied with the block: move it inside.');
      }
      const next = L[openIdx + 1];
      if (next && next.kind !== 'blank' && !/<\/details>/i.test(next.t)) {
        warn(next.n, 'leave a blank line after </summary> so Markdown inside the block renders');
      }
    }

    let run = 0, startLine = 0;
    const end: Line = { n: 0, t: '', kind: 'end', inDetails: false };
    for (const l of [...visible, end]) {
      if (l.kind === 'code') { if (!run) startLine = l.n; run++; continue; }
      if (run > GROSS_CODE_LINES) warn(startLine, `code block of ${run} lines in the visible body. Long logs and data belong in "Agent context".`);
      run = 0;
    }
  }

  const shown = visible.filter((l) => l.kind !== 'blank').length;
  if (shown > GROSS_LINES[kind]) {
    warn(0, `visible body is ${shown} lines. A reader will not finish it. Check what a reviewer needs and move the rest into "Agent context".`);
  }

  const sort = (a: Finding[]): Finding[] => a.sort((x, y) => x.line - y.line);
  return { errors: sort(errors), warnings: sort(warnings) };
}
