---
name: wat-diagram
description: Make a system design diagram as an SVG and attach it to a GitHub issue, PR or comment. Writes a small JSON spec of C4 elements and relationships with optional change status (added, changed, removed, affected), lints it against C4 notation, renders it with ELK layout, and uploads it with gh --attach. Use when the user asks for an architecture, context, container, component, code, sequence or before/after diagram, or when another wat skill calls for one.
license: MIT
---

# wat-diagram

Policy check first: follow section 1 of the `wat` skill (`../wat/SKILL.md`). Which diagram type: the `wat-architecture` skill (`../wat-architecture/SKILL.md`).

A diagram earns its place when it shows structure that a sentence cannot. Small diagrams beat one large one: GitHub draws a body about 860px wide, so a wide image shrinks and a tall one scrolls.

## Steps

1. **Pick the type and scope.** One level per diagram: context, container, component, code, dynamic or deployment. A code diagram shows files and the symbols a change touched: see "Code level" below. A container diagram keeps the people and the external systems that have a line to a container: they show who and what the system talks to.
2. **Get the elements.**
   - From a change: `npx gh-wat-dis impact | npx gh-wat-dis graph from-facts > .wat-tmp/change.json`. The spec holds the elements the change touched, the ones it reaches, and both ends of each relationship it added or removed. It is scoped already: do not run `focus` on it. `--all` gives the whole map with the statuses on it.
   - From a change, at code level: `npx gh-wat-dis impact | npx gh-wat-dis graph from-facts --level file > .wat-tmp/code.json`.
   - From the map: `npx gh-wat-dis graph from-config > .wat-tmp/system.json`. That spec holds every element, components included. For the container view of the whole system, pipe it through `collapse`, which folds the components into their containers: `npx gh-wat-dis graph from-config --type container --title "<System>: containers" | npx gh-wat-dis graph collapse --to-type container > .wat-tmp/containers.json`. `--type` and `--title` label the diagram. A whole-system view shows the map as it is: keep every relationship and its label. Do not drop or reword one to tidy the picture; when there are many, the renderer numbers the lines and the legend table carries the words. If the map is wrong or out of date, say so in your reply and offer to correct the map, not the picture.
   - From neither: read the code. Never draw an element you did not find.
3. **Shape the spec** when it needs it. The spec is the one format every graph tool reads and writes, so shape it in steps. A spec from `from-facts` often needs none. A spec from the map, or one with more than about 8 elements, does:
   ```bash
   npx gh-wat-dis graph stats .wat-tmp/change.json     # how big is it?
   npx gh-wat-dis graph collapse .wat-tmp/change.json --to-type container > .wat-tmp/<name>.json
   npx gh-wat-dis graph focus .wat-tmp/system.json --on <id,id> --hops 1 > .wat-tmp/<name>.json
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
   Fix every lint error. Fix warnings unless the fact is not known; then say so in the body under `Unknowns`. When the fact is known and the architecture map lacks it (a relationship with no `technology`), set it in the spec, tell the user, and offer to save it in `.agents/gh-wat-dis/config.json`.
   The title names the change ("Checkout: payment retries move to a worker"). For a view of the system with no change in it, name the system and the view: "Storefront: containers".
5. **Read what the renderer reports.** It lays the spec out several ways (top-down and left-to-right, words or numbers on the lines, one row or two) and judges each one: size, and also how far the lines run, how many corners and crossings they have, and whether a line or a label lies on a box. It keeps the one that reads best. Stderr has these lines:
   - The size: `681 x 766px, top down`.
   - `numbered lines`: add the legend table under the image: `npx gh-wat-dis legend .wat-tmp/<name>.json`. Row n of the table is the line that carries the number n.
   - `layout:` what it kept and what each other choice cost. "left to right is 1449px wide" means the direction in the spec did not fit, so the drawing was turned. Leave it turned, or pass `--direction` to force yours.
   - `warning:` one for each fault that is left: too wide, taller than 900px, a line that runs far out of its way, lines through a box or through the name of a group, three or more crossings, a label or a line on top of another. A drawing with no warning needs no reshaping.
   - `fix:` a filter or an option that the tool applied to your spec and judged again, with the size it gives and the warnings it leaves. Only a fix that leaves fewer warnings is printed. Run the first one that keeps the elements your text is about, then render again:
     ```text
     warning: 902px is wider than GitHub's 860px body, so text will shrink
     warning: 6 line crossings on 17 lines
     fix: graph collapse --to-type container gives 742 x 372px with 5 elements and no warning
     ```
     ```bash
     npx gh-wat-dis graph collapse .wat-tmp/<name>.json --to-type container > .wat-tmp/<name>-2.json
     ```
     A fix that starts with "no" names an option to leave off: `no --direction right`.
   - `fix: none found` lists what was tried and judged no better. Then no filter mends the picture. Cut it by hand: keep the elements the text names, remove the rest from the JSON, or draw two diagrams with `graph split` (below).

   The renderer never keeps a layout that cannot draw every relationship from end to end. When the report says a relationship could not be drawn in any layout, cut the diagram down.
   To read the same judgement as data, add `--report`: stdout is then one JSON object with the size, `why`, `warnings`, `fixes`, and `candidates`, the metrics of every layout tried (`detour`, `bends`, `crossings`, `through`, `overlaps`, `titles`, `broken`, `score`, and `chosen`).
6. **Look at it.** Draw a PNG beside the SVG and open it with your image tool:
   ```bash
   npx gh-wat-dis diagram .wat-tmp/<name>.json -o .wat-tmp/<name>.svg --png .wat-tmp/<name>.png
   ```
   Check that no label overlaps a box, that nothing is cut at an edge, that no line takes a route you would not draw by hand, and that the changed elements stand out. The report catches most of this, and your eyes catch the rest. If it reads as a hairball, cut elements or split the diagram. This command is the way to see a diagram: it draws the whole image at twice its size, which a preview or thumbnail tool does not promise. The PNG is for you to inspect. GitHub gets the SVG. The PNG shows the light colours, and both colour schemes share one layout, so one look covers both.
7. **No issue or PR to put it in?** When the user asked only for the diagram, stop here: give the path of the SVG and print the legend table when the lines are numbered. Do not attach it anywhere.
8. **Reference it** in the body by its local path, centred. The alt text is the diagram title:
   ```markdown
   <div align="center">

   ![Checkout: payment retries move to a worker](./<name>.svg)

   </div>
   ```
   Write the three parts at the start of their lines in the body, with the blank lines as shown: GitHub centres what is inside the `div`, and it renders the image only when a blank line separates it from the tags. Write the path relative to the body file. Put the diagram right after the opening and the alert.
9. **Attach on post.** Repeat `--attach` for each diagram: `gh issue create|edit --body-file <body> --attach <svg> --attach <svg2>` or `gh pr create|edit ...`. Run `gh` from the folder that holds the body file, and pass each file as the body writes it: the body says `![Title](./<name>.svg)`, the flag says `--attach ./<name>.svg`. `gh` matches the two, uploads the file and puts the uploaded URL where the local path was. Then read the posted body: every image link starts with `https://`. A local path still in the body means the two did not match and `gh` put the image at the end. Repair it by moving that URL into the image line and updating the body with `gh issue edit` or `gh pr edit --body-file`.

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
| `type` | `context`, `container`, `component`, `code`, `dynamic`, `deployment`, `landscape` |
| `direction` | `DOWN` or `RIGHT`. A wish: the renderer turns the drawing when the other way reads much better. Omit it to let the renderer choose. |
| element `type` | `person`, `system`, `container`, `component`, `datastore`, `queue`, `boundary`, `node`, and `file` in a code diagram |
| `kind` | Free text that replaces the type label: `Web Worker`, `WASM module`, `Thread`, `npm package`, `Rust crate`, `Shared memory` |
| `parent` | id of a `boundary`, `node` or `system` element: nests the element inside it |
| `detail` | `auto` (default), `full`, `compact`. Compact shows name and technology only. `auto` goes compact above 5 elements. |
| `external` | `true` for anything the team does not own |
| `status` | `added`, `changed`, `removed`, `affected` (reached, not modified). Omit for unchanged. |
| relationship `order` | Step number on a `dynamic` diagram |
| file `symbols` | Rows of a `file` card: `{ "name", "kind", "status" }`. See "Code level". |
| relationship `toSymbol`, `fromSymbol` | The symbol row of a `file` that the line ends on or leaves from |

## Rules

- **Names match the architecture map**, letter for letter. The body and the diagram use the same words.
- **Every relationship has a label** that says what moves or happens, in the direction of the arrow. Never "uses" or "calls". Container-to-container lines name the protocol in `technology`.
- **Status carries the change.** One diagram shows before and after: `removed` for what goes, `added` for what comes. Do not draw a "before" and an "after" diagram.
- **Descriptions stay near 60 characters**, one short line. The linter warns past 120. The body holds the detail.
- **Show one hop.** Changed elements plus their direct neighbours. Leave out the rest of the system.
- **A flow has 8 steps at most.** Longer flows go in a numbered list, and the linter warns. Each `order` is a whole number from 1, used once.
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
- **Draw a build-time edge only when the change is about it.** An `import type` of a shared types package is left out, and the body names the package. When the change adds, removes or reshapes that contract, draw the edge and put the mechanism in `technology`.
- **Nest by where code runs, not by folder.** A package that runs in two contexts appears in the one this change touches.

## Code level

A code diagram is C4 level 4, for a change. A file is a card. Its header is the path. Under it is one row for each symbol the change added (`+`), changed (`~`) or removed (`−`). A line runs from a file to the symbol it imports and ends on that symbol's row. The architecture element a file belongs to is named above the card, or drawn as a light band round its files.

Use it when the point of the change is inside the code:

- A hard change inside one module or a few: the component diagram would show one box marked "changed".
- A change about which functions moved, split, appeared or went away.
- A changed signature, where the reader needs to see who imports it.

Do not use it for a change that adds or removes an element or a relationship: that is a container or component diagram. A pull request may carry both.

One command writes the spec from the facts:

```bash
npx gh-wat-dis impact | npx gh-wat-dis graph from-facts --level file > .wat-tmp/code.json
npx gh-wat-dis diagram .wat-tmp/code.json -o .wat-tmp/code.svg --png .wat-tmp/code.png
```

It draws up to 8 files (`--max-files`). Changed source files come first, the ones with the most change at the top: lines changed and complexity gained. A list of re-exports, a fixture or a build config ranks below real code. Two slots are kept for files outside the diff: a file that imports a changed symbol by name, and a file that a changed file starts to import. A changed file that is not source in TypeScript, JavaScript or Rust, such as a page or a manifest, is not drawn.

The picture shows only what the source proves:

- A line ends on a symbol row when the importing file names that symbol in its import. An import of the whole module (a namespace import, a dynamic `import()`, a class whose method changed) ends on the file's header.
- A green line with `+` is an import the change added. A row with no mark is a symbol that did not change and that a file starts to import.
- Rows list the symbols the change added, changed or removed, private ones too, the most changed first. A comment or a reformat is not a change.
- The blue dot on a file outside the diff means it imports, by name, a symbol whose signature changed or that was removed.
- A card that says "not read" is a file over 500 KB: its symbols and imports are unknown. A card that says "moved from" is a rename.

The scope line under the title says how many changed source files are drawn, names the largest ones left out, and counts moved files and other changed files. Stderr lists the rest. When the largest file left out matters to the change, raise `--max-files` or say so in the body. When no source file changed, the command exits 1 and there is no code diagram to draw.

Then open the JSON and fix what the facts cannot know. Set the `title` to name the change. Drop a card that adds nothing with `graph drop --ids <path>`. Add a line the import graph does not see, such as a script that writes a page: give it a `label`, and it is drawn with its words. To end a line on a symbol that did not change, add that symbol to the file's `symbols` with no `status`.

```json
{
  "title": "Payment retries move to idempotency keys",
  "type": "code",
  "direction": "RIGHT",
  "elements": [
    { "id": "payments", "type": "boundary", "name": "Payment service" },
    { "id": "retry", "type": "file", "name": "services/payments/src/retry.rs", "parent": "payments", "status": "changed",
      "symbols": [
        { "name": "retry_authorisation", "kind": "fn", "status": "changed" },
        { "name": "backoff_schedule", "kind": "fn", "status": "removed" }
      ] },
    { "id": "keys", "type": "file", "name": "services/payments/src/idempotency.rs", "parent": "payments", "status": "added",
      "symbols": [{ "name": "release", "kind": "fn", "status": "added" }] }
  ],
  "relationships": [
    { "from": "retry", "to": "keys", "toSymbol": "release", "label": "" }
  ]
}
```

- A line between two files may have an empty `label`: it means an import, and the key says so.
- A card draws 8 rows at most. List the symbols the change is about.
- Left to right is the form that ends lines on rows. Top down, lines end on the card.
- About five files fit in 700 by 350 pixels. Past eight, make two diagrams.

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
- `direction: RIGHT` suits a pipeline of 4 or fewer stages. It gets wide fast, and the renderer turns it top down when it does.
- Remove an edge that the reader does not need for this change.

## Options

| Need | Command |
|---|---|
| Check a spec only | `npx gh-wat-dis diagram spec.json --lint-only` |
| Show or hide descriptions | `--detail full` or `--detail compact` |
| Words or numbers on the lines | `--labels text` or `--labels numbered` (default `auto`) |
| The judgement as JSON | `--report` |
| Force a direction | `--direction down` or `--direction right` |
| Fit another width | `--max-width 700` |
| Legend table for numbered lines | `npx gh-wat-dis legend spec.json` |
| Force a palette | `--theme light` or `--theme dark` (default `auto` carries both palettes and follows the page it is shown on) |
| Two files for a `<picture>` tag | `--theme split` writes `.light.svg` and `.dark.svg` |
| Mermaid text, no file | `npx gh-wat-dis diagram spec.json --mermaid` |

Use the Mermaid output only where an attachment is not possible: a milestone tracking comment from a tool with no `gh`, or a repo on GitHub Enterprise Server.

## Updating a diagram

Edit the spec, render again, and edit the body with the new file: `gh issue edit <n> --body-file <body> --attach <svg>`. Keep the spec inside the Agent context code block, under a "Diagram spec" heading line, so the next agent can change it.
