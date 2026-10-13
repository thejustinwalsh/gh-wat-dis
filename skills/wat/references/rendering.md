# What GitHub renders

Use the richest element that carries the information in the fewest words. Check the surface first.

## By surface

| Element | Issue / PR body, comments | Milestone description |
|---|---|---|
| Tables, bold, lists, links, emoji | Yes | Yes |
| Task lists `- [ ]` | Yes. Progress shows in lists only when they sit in the body. | No progress effect |
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

## Choose the element

| You need to show | Use |
|---|---|
| Structure: elements and relationships | SVG from `npx gh-wat-dis diagram` |
| Before vs after | 2-column table, or one diagram with change status |
| A sequence over time | Numbered list, or a dynamic diagram for 4+ actors |
| A small config or API change | ` ```diff ` block |
| The one blocking caveat | One alert |
| Work items | Task list in the body; sub-issues for more than 5 |
| Long logs, facts, file lists | `<details>` agent block |
| Status | Labels, fields, sub-issue progress. Not prose. |

## Images

- **Attach with `gh`.** `gh issue create --body-file body.md --attach ./diagram.svg`. Reference the local path in the body (`![Title](./diagram.svg)`) and `gh` swaps in the uploaded URL. Without a reference, `gh` appends the image.
- Formats: PNG, JPEG, GIF, WebP, SVG, MP4, MOV, WebM. 10 MB per image.
- Needs gh 2.99.0 or later, GitHub.com or Enterprise Cloud, and write access.
- An SVG renders through `<img>`: no scripts, no external fonts, no links inside it. `npx gh-wat-dis diagram` output already fits.
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
| Kind of work | Issue type (org repos) or a `type:` label |
| Priority, effort, dates | Issue fields, or labels from the repo config |
| Release | Milestone |
| Breakdown | Sub-issues (100 per parent, 8 levels) |
| Order | Dependencies: blocked by / blocking |
| What a PR finishes | `Closes #n` in the PR body |

## Limits

| Item | Limit |
|---|---|
| Issue, PR or comment body | 65,536 characters. Budget 60,000. |
| Title | 256 characters. Aim for 70. |
| Label name / description | 50 / 100 characters |
| Pinned issues | 3 per repo |
