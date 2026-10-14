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
   - From a change: `npx gh-wat-dis impact | npx gh-wat-dis graph from-facts > .wat-tmp/change.json`. The spec holds the elements the change touched, the ones it reaches, and both ends of each relationship it added or removed. It is scoped already: do not run `focus` on it. Its lines name what the tools saw imported across them; relabel each with what it does. `--all` gives the whole map with the statuses on it.
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
5. **Compose, then read what the renderer reports.** You state the structure, and the renderer keeps to it:
   - **Order the relationships as you would tell them.** The drawing starts at the source of the first relationship and reads on from there. In a cycle, the relationship that returns to an element already drawn is the one drawn backwards. A flow reads in `order`.
   - **Group with `parent`.** A group is as wide as its name, and no line is routed through the name. Keep a group name under 40 characters.
   - **Name a `direction` only when it matters.** A direction in the spec or on the command line is never overridden. Leave it out and each type takes its own form: a code diagram is layers of files left to right so that a line ends on a symbol row, and the other types run top down or left to right, whichever reads better.
   - **Stay inside the budget of the type**, in elements that are not groups and in relationships: context 8 and 10, container, component, deployment and landscape 12 and 14, code 8 files and 8 lines in at most three layers, flow 8 steps. Every type also holds a chain of at most 8 elements, with at most 4 side by side at any step of it. A spec inside the budget has a layout that passes every gate: the tests generate specs at these limits to keep that true. Lint warns past it and names the filter that brings the spec back in, with what the filter leaves. `graph from-facts` stays inside it and says in the scope line what it left out.

   A layout must pass every gate: each relationship is drawn from end to end on its own element or row, no line runs through text, nothing lies on top of anything else, the lines are calm (no line runs more than twice as far as it needs to, and there is at most one crossing for every four lines), and the whole image is at most 860px wide and 1376px tall. The renderer starts from the form of the type and loosens it one rung at a time: numbers on the lines or a long chain wrapped, then both, then compact cards. A code diagram is never wrapped. It draws the first rung that passes. When that drawing is taller than 900px and the wrapped one on the next rung has a better shape with lines as calm, it draws the wrapped one. Stderr has these lines:
   - The size of the whole image, title and key included: `681 x 766px, top down`. Every size the tool prints is this measure.
   - `numbered lines`: add the legend table under the image: `npx gh-wat-dis legend .wat-tmp/<name>.json`. Row n of the table is the line that carries the number n.
   - `layout:` what was kept, the rung, and why each rung above it failed: `kept top down, numbers on the lines: rung 2 of 3. rung 1 (as written) is 968px wide`.
   - `layout: no layout passes every check on any of the 3 rungs. Drew the nearest: …` means the spec is past what one picture holds. The image is still written, in the layout with the calmest lines. Apply a `fix:` or cut the spec before you attach it.
   - `warning:` one for each fault that is left: an image wider than 860px or taller than 900px, a line that runs far out of its way, three or more crossings, and each gate the drawing fails. A drawing with no warning needs no filter. Look at it all the same (step 6): the checks do not see everything a reader does.
   - `fix:` a filter or an option that the tool applied to your spec, drew and judged again, with the size of the image it gives, the warnings it leaves, and what it takes out. Only a fix that leaves fewer warnings, or that makes a drawing pass which no rung could, is printed, and never one that makes the picture wider or adds crossings. A fix is drawn before it is offered, and one that takes out or folds away an element or a line that the change added, changed or removed is not offered at all. Run the first one whose removals your text can do without, then render again:
     ```text
     warning: 902px is wider than GitHub's 860px body, so text will shrink
     warning: 6 line crossings on 17 lines
     fix: graph collapse --to-type container gives 790 x 548px with no warning. It folds 6 elements into their groups.
     ```
     ```bash
     npx gh-wat-dis graph collapse .wat-tmp/<name>.json --to-type container > .wat-tmp/<name>-2.json
     ```
     A fix that starts with "no" names an option to leave off: `no --direction right`. `graph set --direction ""` takes a direction out of the spec.
   - A fix that reads "graph split gives 3 diagrams, the largest …" means the split views all read better than the one picture: run `graph split` (below). A fix that reads "shorten the group name …" is an edit to the spec.
   - `fix: none found` lists what was tried and judged no better. Then no filter mends the picture. Cut it by hand: keep the elements the text names and delete the rest from the JSON. To remove one relationship, delete its entry from `relationships`: no filter does that.

   To read the same judgement as data, add `--report`: stdout is then one JSON object with the size, `why`, `rung`, `rungs`, `passed`, `warnings`, `fixes`, and `candidates`: every layout tried, with its `rung`, the gates it `fails`, and its metrics (`crossings`, `detour`, `bends`, `broken`, `through`, `titles`, `struck`, `overlaps`, `clipped`, and `chosen`).
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
| `direction` | `DOWN` or `RIGHT`. The renderer never overrides it. Omit it and the diagram takes the form of its type. |
| element `type` | `person`, `system`, `container`, `component`, `datastore`, `queue`, `boundary`, `node`, and `file` in a code diagram |
| `kind` | Free text that replaces the type label: `Web Worker`, `WASM module`, `Thread`, `npm package`, `Rust crate`, `Shared memory` |
| `parent` | id of a `boundary`, `node`, `system`, `container` or `component`: nests the element inside it. The key calls these "Group" when one is not a boundary. A person, a store, a queue or a file holds nothing. |
| `detail` | On the spec, not on an element: `auto` (default), `full`, `compact`. Compact shows name and technology only. `auto` goes compact above 5 elements. |
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

It draws up to 8 files (`--max-files`). Changed source files come first, the ones with the most change at the top: lines changed and complexity gained. A list of re-exports or a build config ranks below real code, and a test, an e2e spec or a fixture never takes a card before source does. At least two slots are kept for files outside the diff: a file that imports a changed symbol, and a file that a changed file starts to import. A file that imports the most changed file is kept before any other extra card. A changed file that is not source in TypeScript, JavaScript or Rust is not drawn.

One rule decides the lines, so a reader can trust a line and the lack of one:

- **One line for each file that imports another.** `impact` reads the imports of every file that can be a card, on both sides of the diff, so every import between two drawn files is a line, whether either file is in the diff or not. No line between two cards means neither imports the other. A dynamic `import()` that names what it takes counts like a static import.
- **A line ends on a symbol row** when the import names exactly one name, and that name has a row. **It ends on the file's header** otherwise: several names, the whole module, or a name with no row. Which names an import takes is in the facts, for the Agent context.
- **Green with `+`** is an import that is not on the base side: one a file gained, and every import of a new file. **Red** is an import the change removed, to a deleted file too. Grey is an import that was there before and still is, whatever names it gained.
- **Through a re-export.** A file that takes a name through a module that re-exports it has a line to that module when the module is a card, and the module's re-export is a line on from there. When the module is not a card, the line goes straight to the file the name comes from.
- **Rows** are the symbols the change added, changed or removed, private ones too, the hardest work first: the largest rise in complexity, then the most lines changed, then a new export. So the function whose complexity rose most is always a row. A row with no mark is a symbol that did not change and that a file starts to import. A comment or a reformat is not a change, and a function renamed with the same body is a change of name, not a new function.
- **A card lists six changed symbols**, then says "and N more symbols". A line to one of those ends on the header. A name that does not fit its card loses its leading parts whole (`…Sprite2D.addEffect` keeps the part that names it), and only a plain name is cut in the middle.
- **The blue dot** on a file outside the diff means it imports, by name, a symbol whose signature changed or that was removed.
- **"not read"** on a card is a file over 500 KB: its symbols and imports are unknown. **"moved from"** is a rename. A moved file keeps its imports: a move alone adds no green line.

What the facts cannot prove is not drawn: a Rust path written in full without `use` is not seen. When the change moves, adds or removes a Rust module, the Rust lines are all grey: the base side cannot be compared.

The scope line under the title says how many changed source files are drawn, names the two largest left out by the shortest tail of their path that no other file shares, and counts moved files, source in a language the tools do not read, and other changed files. Stderr lists the first six of each kind left out. When the largest file left out matters to the change, raise `--max-files` or say so in the body. When no source file changed, the command exits 1 and there is no code diagram to draw.

A code diagram has one form: layers of files by import depth, left to right. A file stands to the left of what it imports, so every line runs to the right and ends on the row or the header it concerns. Files that import one another share a layer, and the lines between them turn beside the cards, on their right. The name of a group is a small label at the top of each of its cards: groups take no room of their own. Leave `direction` out of a code spec.

A code diagram holds three layers and 8 lines. `graph from-facts` keeps the three layers that hold the file with the most change, leaves out the files that stand further out (those outside the diff first, and smaller changes before bigger ones), then the last file of a layer too tall for one image, then the last file while there are more than 8 lines, and names them in the scope line. In a spec you write, list the file the diagram is about first, and keep the imports three files deep: lint names the files to drop when they are deeper, and `graph split` writes one diagram for each group.

Then open the JSON and fix what the facts cannot know. Set the `title` to name the change. Drop a card that adds nothing with `graph drop --ids <path>`: the scope line then counts one changed file fewer drawn and says a card was removed by hand. Add a line the import graph does not see, such as a script that writes a page: give it a `label`, and it is drawn with its words. To end a line on a symbol that did not change, add that symbol to the file's `symbols` with no `status`.

```json
{
  "title": "Payment retries move to idempotency keys",
  "type": "code",
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
- A card draws 8 rows at most: six changed symbols and up to two unmarked ones. Name a symbol among the first 8 when a line must end on it.
- Give a file a `parent` to label its card with the name of that group.
- Do not pass `--labels numbered` for a code diagram: its lines have no words to look up.
- Three layers of cards fit the page, and cards are wider when there are fewer layers. Past eight files, make two diagrams: `graph split` writes one per group.

## Overview plus scoped views

When one diagram would be large, make several small ones:

```bash
npx gh-wat-dis graph split .wat-tmp/change.json --out-dir .wat-tmp/views
```

It writes `overview.json`, with every group folded to one box, and one `<group>.json` for each group that holds a change, with that group opened and its neighbours folded. Render each one. Pass `--groups id,id` to choose the groups, and `--all` for a view of every group.

Place the overview after the opening and each scoped view beside the text about that part. See "Diagrams" in `../wat/references/formats.md`.

## Flows

A `dynamic` diagram starts at the top left with step 1 and reads on in step order. Give each relationship an `order`. The steps keep their words when they fit. When the report says `numbered lines`, the words go in the legend table:

```bash
npx gh-wat-dis diagram .wat-tmp/flow.json -o .wat-tmp/flow.svg
npx gh-wat-dis legend .wat-tmp/flow.json >> .wat-tmp/issue.md
```

Use a flow for behaviour over time: a request path, a retry, a migration sequence. Use a container or component diagram for structure.

## Keep it compact

- Above 5 elements the renderer drops descriptions. The body's `Change` table carries them.
- A chain of more than 5 steps top to bottom reads as a scroll. Cut it with `graph focus`, or fold a side with `graph collapse`.
- Name `direction: RIGHT` only for a pipeline of 4 or fewer stages. It is kept as named, however wide it gets.
- Keep a label under 80 characters and a group name under 40. The rest belongs in the text.
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
