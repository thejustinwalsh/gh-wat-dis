# What GitHub renders

Use the richest element that carries the information in the fewest words. Check the surface first.

## By surface

| Element | Issue / PR body, comments | Milestone description |
|---|---|---|
| Bold, lists, links, inline code | Yes | Yes on the milestone page. The milestones list prints the source as plain text. |
| Tables, emoji | Yes | Do not use: not checked |
| Task lists `- [ ]` | Yes. Progress shows in lists only when they sit in the body. | Do not use: boxes nobody can tick, no progress effect |
| Issue reference `#12` | Yes, a link | Plain text, no link. A full issue URL becomes a link. |
| Alerts `> [!NOTE]` `[!TIP]` `[!IMPORTANT]` `[!WARNING]` `[!CAUTION]` | Yes. Cannot nest inside lists or tables. | Do not use |
| `<details><summary>` | Yes. Leave a blank line after `</summary>`. | Do not use |
| Attached SVG / PNG (`gh --attach`) | Yes | No |
| Mermaid | Yes, safe set only (below) | No |
| ` ```diff ` blocks | Yes. Cheap red/green without an image. | Plain code |
| Colour chips `` `#0969da` `` | Yes | No |
| `<kbd>`, `<sub>`, `<sup>`, footnotes `[^1]` | Yes | Unreliable |
| Permalink code embeds | Comments, same repo, commit SHA link on its own line | No |
| Math `$..$` | Yes | No |
| `<picture>` light/dark sources | Yes | No |

The milestone column was read from GitHub's pages: see "Milestone" in [formats.md](formats.md) for what was checked and where.

## Choose the element

| You need to show | Use |
|---|---|
| Structure: elements and relationships | SVG from `npx gh-wat-dis diagram` |
| A visible change, before vs after | Two captures in a `Before` / `After` table; text output as two labelled code blocks. See "Before and after" in the formats |
| A structural change, before vs after | One diagram with change status |
| A sequence over time | Numbered list, or a dynamic diagram for 4+ actors |
| A small config or API change | ` ```diff ` block |
| The one blocking caveat | One alert |
| Work items | Task list in the body; sub-issues for more than 5 |
| Long logs, facts, file lists | `<details>` agent block, one code block inside it (GitHub adds a copy button) |
| Status | Labels, fields, sub-issue progress. Not prose. |

## Images

- **Centre a diagram** by wrapping its image line in `<div align="center">` and `</div>`, with a blank line inside each tag. GitHub keeps the `align` attribute and centres the image. The image line stays Markdown, so `gh --attach` still finds the local path.
- **Attach with `gh`.** `gh issue create --body-file body.md --attach ./diagram.svg`. Reference the local path in the body (`![Title](./diagram.svg)`) and `gh` swaps in the uploaded URL. Without a reference, `gh` appends the image.
- Formats: PNG, JPEG, GIF, WebP, SVG, MP4, MOV, WebM. 10 MB per image.
- Needs gh 2.99.0 or later, GitHub.com or Enterprise Cloud, and write access.
- An SVG renders through `<img>`: no scripts, no external fonts, no links inside it. `npx gh-wat-dis diagram` output already fits.
- An SVG in `<img>` is its own document. It gets no colours from the page: `currentColor` is black, and GitHub exposes no theme variables to it. A `prefers-color-scheme` rule inside the SVG does work, and in Chrome it follows the page's colour scheme, so it tracks the reader's GitHub theme. The renderer's `auto` theme relies on that and keeps an opaque background for browsers that differ.
- Always write alt text. The alt text is the diagram title.
- Inline `<svg>` and `data:` URIs are stripped. Do not use them.
- Fallback when `--attach` is not available: commit the file to a branch and link `../blob/<branch>/<path>.svg?raw=true`.

## Mermaid

Prefer `npx gh-wat-dis diagram` for architecture. Use Mermaid only for a quick sequence or state sketch.

Safe: `flowchart`, `sequenceDiagram`, `classDiagram`, `stateDiagram-v2`, `erDiagram`, `gantt`, `pie`, `gitGraph`.
Do not rely on: `C4Context`, `architecture-beta`, `block-beta`, `sankey-beta`, `xychart-beta`, `kanban`, `packet`. GitHub's Mermaid version lags upstream.

## Structured fields beat prose

| Fact | Where it goes |
|---|---|
| Kind of work: Task, Bug, Feature | The **issue type** in an organization repository. A repository under a user account has no issue types, so there it is a **type label**: `task`, `bug`, `feature`. `issues.typeSource` in the repo config says which. Exactly one type for each issue. |
| Priority | A **priority label**: `critical`, `major`, `minor` or `nit`. A person decides it; triage proposes it and writes it in an approved row. One per issue |
| Size | A **size label**: `s`, `m`, `l` or `xl`. One per issue |
| Product surface the work touches | A **surface label**, from `labels.surfaces` in the repo config |
| An agent owns the issue, or the issue holds a prompt an agent runs on a schedule | The **`agents` label** |
| Release | Milestone |
| Breakdown | **Sub-issue** of a parent (100 per parent, 8 levels) |
| Order | **Blocked by / blocking** |
| What a PR finishes | `Closes #n` in the PR body |

Labels mean those four things (surface, agents, priority, size), plus the type on a user repository. Do not create a label for status, and do not create a type label where issue types exist.

A relation between two issues goes in GitHub's relations, not in prose. "Refs #12" in a body shows in no sidebar and no filter. Use a sub-issue for "part of", and blocked by for "must wait for". Keep `Refs #n` for a link that is neither: related reading, a PR that touches an issue without finishing it.

## Limits

| Item | Limit |
|---|---|
| Issue, PR or comment body | 65,536 characters. Budget 60,000. |
| Title | 256 characters. Aim for 70. |
| Label name / description | 50 / 100 characters |
| Pinned issues | 3 per repo |
