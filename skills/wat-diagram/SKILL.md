---
name: wat-diagram
description: Make a system design diagram as an SVG and attach it to a GitHub issue, PR or comment. Writes a small JSON spec of C4 elements and relationships with optional change status (added, changed, removed, affected), lints it against C4 notation, renders it with ELK layout, and uploads it with gh --attach. Use when the user asks for an architecture, context, container, component, sequence or before/after diagram, or when another wat skill calls for one.
license: MIT
---

# wat-diagram

Policy check first: follow section 1 of the `wat` skill (`../wat/SKILL.md`). Which diagram type: the `wat-architecture` skill (`../wat-architecture/SKILL.md`).

A diagram earns its place when it shows structure that a sentence cannot. Small diagrams beat one large one: GitHub draws a body about 860px wide, so a wide image shrinks and a tall one scrolls.

## Steps

1. **Pick the type and scope.** One level per diagram: context, container, component, dynamic or deployment.
2. **Get the elements.**
   - From a change: `npx gh-wat-dis impact | npx gh-wat-dis graph from-facts > .wat-tmp/change.json`.
   - From the map: `npx gh-wat-dis graph from-config > .wat-tmp/system.json`.
   - From neither: read the code. Never draw an element you did not find.
3. **Shape the spec.** The spec is the one format every graph tool reads and writes, so shape it in steps:
   ```bash
   npx gh-wat-dis graph stats .wat-tmp/change.json     # how big is it?
   npx gh-wat-dis graph focus .wat-tmp/change.json --on status:changed,added,removed --hops 1 \
     | npx gh-wat-dis graph collapse --to-type container > .wat-tmp/<name>.json
   ```
   | Filter | Use it to |
   |---|---|
   | `from-facts` / `from-config` | Start a spec from impact facts or the architecture map |
   | `focus --on <ids or status:...> --hops N` | Keep some elements and their neighbours |
   | `collapse --into <id>` / `--to-type container` | Fold components into their parent |
   | `drop --ids` / `--status unchanged` / `--external` / `--orphans` | Remove noise |
   | `merge a.json b.json` | Join two specs |
   | `diff base.json head.json` | Mark added, removed and changed between two specs |
   | `set --element <id,id> key=value` / `set --title` | Fix a name, technology or status on one or more elements |
   | `set --relationship <from>:<to>,<from>:* key=value` | The same for relationships. `*` matches any element. |
   | `rename <old> <new>` | Change an id everywhere |

   Then open the JSON and fix what filters cannot know: relationship labels that say what moves, and technology. Writing a spec by hand from the start is also fine.
4. **Render.**
   ```bash
   npx gh-wat-dis diagram .wat-tmp/<name>.json -o .wat-tmp/<name>.svg
   ```
   Fix every lint error. Fix warnings unless the fact is not known; then say so in the body under `Unknowns`.
5. **Read what the renderer reports.** It tries top-down and left-to-right, with words or numbers on the lines, and keeps the shortest layout that fits 860px. It prints the size and the layout it chose.
   - `numbered lines`: add the legend table under the image: `npx gh-wat-dis legend .wat-tmp/<name>.json`.
   - `wider than GitHub's 860px`, or taller than about 900px: split it (below) or cut elements.
6. **Look at it.** Open the SVG or a rasterized copy. Check that no label overlaps a box and that the changed elements stand out. If it reads as a hairball, cut elements or split the diagram.
7. **Reference it** in the body by its local path. The alt text is the diagram title:
   ```markdown
   ![Checkout: payment retries move to a worker](./<name>.svg)
   ```
   Write the path relative to the body file. Put the diagram right after the opening and the alert.
8. **Attach on post.** Repeat `--attach` for each diagram: `gh issue create|edit --body-file <body> --attach <svg> --attach <svg2>` or `gh pr create|edit ...`. `gh` uploads the file and swaps the local path for the uploaded URL. Check the posted body: the image link must start with `https://`.

## Spec

```json
{
  "title": "Checkout: payment retries move to a worker",
  "type": "container",
  "scope": "Storefront",
  "direction": "DOWN",
  "elements": [
    { "id": "shopper", "type": "person", "name": "Shopper", "description": "Buys products" },
    { "id": "api", "type": "container", "name": "Orders API", "technology": "Rust, Axum",
      "description": "Owns orders and payments", "status": "changed" },
    { "id": "queue", "type": "queue", "name": "Retry queue", "technology": "SQS",
      "description": "Holds failed charges", "status": "added" },
    { "id": "worker", "type": "container", "name": "Payments worker", "technology": "Rust",
      "description": "Retries failed charges", "status": "added" },
    { "id": "stripe", "type": "system", "name": "Stripe", "external": true,
      "description": "Takes card payments" }
  ],
  "relationships": [
    { "from": "shopper", "to": "api", "label": "Places orders through", "technology": "HTTPS" },
    { "from": "api", "to": "queue", "label": "Enqueues failed charges on", "status": "added" },
    { "from": "worker", "to": "queue", "label": "Takes retries from", "status": "added" },
    { "from": "worker", "to": "stripe", "label": "Retries charges with", "technology": "HTTPS", "status": "added" },
    { "from": "api", "to": "stripe", "label": "Retries charges with", "technology": "HTTPS", "status": "removed" }
  ]
}
```

| Field | Values |
|---|---|
| `type` | `context`, `container`, `component`, `dynamic`, `deployment`, `landscape` |
| `direction` | `DOWN` (default), `RIGHT` for pipelines and sequences |
| element `type` | `person`, `system`, `container`, `component`, `datastore`, `queue`, `boundary`, `node` |
| `kind` | Free text that replaces the type label: `Web Worker`, `WASM module`, `Thread`, `npm package`, `Rust crate`, `Shared memory` |
| `parent` | id of a `boundary`, `node` or `system` element: nests the element inside it |
| `detail` | `auto` (default), `full`, `compact`. Compact shows name and technology only. `auto` goes compact above 5 elements. |
| `external` | `true` for anything the team does not own |
| `status` | `added`, `changed`, `removed`, `affected` (reached, not modified). Omit for unchanged. |
| relationship `order` | Step number on a `dynamic` diagram |

## Rules

- **Names match the architecture map**, letter for letter. The body and the diagram use the same words.
- **Every relationship has a label** that says what moves or happens, in the direction of the arrow. Never "uses" or "calls". Container-to-container lines name the protocol in `technology`.
- **Status carries the change.** One diagram shows before and after: `removed` for what goes, `added` for what comes. Do not draw a "before" and an "after" diagram.
- **Descriptions stay under 60 characters.** The body holds the detail.
- **Show one hop.** Changed elements plus their direct neighbours. Leave out the rest of the system.
- **A flow has 8 steps at most.** Longer flows go in a numbered list.
- The renderer adds the title, the subtitle and the key. Do not repeat them in the body.

## Inside one process or one repository

Not every system is services and databases. For a library, an app in one browser tab, or a monorepo of packages, the same spec draws the software architecture. See [examples/in-process.json](examples/in-process.json) in this skill's folder.

| The thing | Draw it as |
|---|---|
| Execution context: thread, Web Worker, WASM instance, process, iframe | `boundary` with a `kind`, nested by `parent` |
| Package, crate or module | `component` with `kind`: `npm package`, `Rust crate` |
| Shared memory, a cache, an in-memory store | `datastore` with a `kind` |
| A call across a boundary | A relationship whose `technology` names the mechanism: `wasm-bindgen ABI`, `postMessage, structured clone`, `transferred ArrayBuffer`, `SharedArrayBuffer + Atomics`, `FFI`, `function call` |

- **The mechanism is the point.** A reviewer needs to see where data is copied, transferred or shared, and where a call turns async. Put it on the edge.
- **Draw a request and its reply as one edge** when they travel the same channel: "Posts LayoutRequest, gets glyph runs back".
- **Leave out build-time edges** such as `import type` of a shared types package, unless the change is to that contract. Name the package in the body.
- **Nest by where code runs, not by folder.** A package that runs in two contexts appears in the one this change touches.

## Overview plus scoped views

When one diagram would be large, make several small ones:

```bash
npx gh-wat-dis graph split .wat-tmp/change.json --out-dir .wat-tmp/views
```

It writes `overview.json`, with every group folded to one box, and one `<group>.json` for each group that holds a change, with that group opened and its neighbours folded. Render each one. Pass `--groups id,id` to choose the groups, and `--all` for a view of every group.

Place the overview after the opening and each scoped view beside the text about that part. See "Diagrams" in `../wat/references/formats.md`.

## Flows

A `dynamic` diagram draws as a left-to-right flow with numbered steps, and wraps onto a second row to fit the width. Give each relationship an `order`. The words go in the legend table:

```bash
npx gh-wat-dis diagram .wat-tmp/flow.json -o .wat-tmp/flow.svg
npx gh-wat-dis legend .wat-tmp/flow.json >> .wat-tmp/issue.md
```

Use a flow for behaviour over time: a request path, a retry, a migration sequence. Use a container or component diagram for structure.

## Keep it compact

- Above 5 elements the renderer drops descriptions. The body's `Change` table carries them.
- A chain of more than 5 steps top to bottom reads as a scroll. Cut it with `graph focus`, or fold a side with `graph collapse`.
- `direction: RIGHT` suits a pipeline of 4 or fewer stages. It gets wide fast.
- Remove an edge that the reader does not need for this change.

## Options

| Need | Command |
|---|---|
| Check a spec only | `npx gh-wat-dis diagram spec.json --lint-only` |
| Show or hide descriptions | `--detail full` or `--detail compact` |
| Words or numbers on the lines | `--labels text` or `--labels numbered` (default `auto`) |
| Force a direction | `--direction down` or `--direction right` |
| Fit another width | `--max-width 700` |
| Legend table for numbered lines | `npx gh-wat-dis legend spec.json` |
| Force a palette | `--theme light` or `--theme dark` (default `auto` carries both palettes and follows the page it is shown on) |
| Two files for a `<picture>` tag | `--theme split` writes `.light.svg` and `.dark.svg` |
| Mermaid text, no file | `npx gh-wat-dis diagram spec.json --mermaid` |

Use the Mermaid output only where an attachment is not possible: a milestone tracking comment from a tool with no `gh`, or a repo on GitHub Enterprise Server.

## Updating a diagram

Edit the spec, render again, and edit the body with the new file: `gh issue edit <n> --body-file <body> --attach <svg>`. Keep the spec in the Agent context block as a `json` code block so the next agent can change it.
