---
name: wat-architecture
description: Understand and describe software architecture for issues and PRs. Maps a repository to C4 elements (systems, containers, components), saves the map in .agents/gh-wat-dis/config.json, collects labeled facts on what a change reaches with git and AST analysis (TypeScript, JavaScript, Rust), and picks the right diagram type. Use when the user asks how the system fits together, what a change affects, for the blast radius, to map the architecture, or when another wat skill needs element names.
license: MIT
---

# wat-architecture

Policy check first: follow section 1 of the `wat` skill (`../wat/SKILL.md`). Model reference: [references/c4.md](references/c4.md). Other lenses: [references/lenses.md](references/lenses.md).

Three jobs: **map** the system once, **measure** each change, **choose** what to show. The goal is accurate words in an issue or PR. This skill does not review code.

## Map the system

The map gives every issue and PR the same names for the same things. It lives in `.agents/gh-wat-dis/config.json` → `architecture`.

1. **Find the runtime units.** A container is something that must run for the system to work: a web app, an API, a worker, a CLI, a database, a queue, a bucket. Files that ship on their own and that another system loads and runs count as one: a plugin, a set of agent skills, CI workflows. Look for entry points and deploy config, not folders:
   - TypeScript: `package.json` workspaces, `bin`, `main`, `exports`, `scripts.start`
   - Rust: `Cargo.toml` workspace members, `[[bin]]` targets, `src/main.rs`, `cdylib` crates that build WebAssembly
   - Any: `Dockerfile`, `docker-compose.yml`, `Procfile`, Kubernetes and Terraform files, serverless config, CI deploy jobs
   - Connection strings and client constructors for data stores, queues and third-party APIs
2. **Find the people and external systems.** Who calls in (users, other teams' systems, webhooks) and what the code calls out to (payment, email, auth providers).
3. **Find the execution contexts inside a container.** In a browser app or a native app, the boundaries that matter are often inside one process: main thread, Web Workers, a WASM module, a native addon. Map each as a `boundary` with a `kind`. Calls that cross one have a protocol: an ABI, a message format, shared memory. That protocol is a contract.
4. **Find components only where work happens.** A component is a group of code behind one interface: a module with a public entry file, a library crate. Map components for the containers that change often. Skip the rest.
5. **Name relationships by intent and protocol.** "Reads orders from [SQL]", "Publishes OrderPlaced to [Kafka]". Never a bare "uses".
6. **Check against the code.** Run `npx gh-wat-dis elements` to see which files each element maps and which files are unmapped. Run `npx gh-wat-dis impact --base <an older ref>` and compare `edges` with your relationships. An import edge the map lacks is a missing relationship. Add it or ask the user.
7. **Show the user** a container diagram (`wat-diagram`) and the element list. Save the map only after a yes.

```json
"architecture": {
  "system": { "name": "Storefront", "description": "Sells products to shoppers" },
  "elements": [
    { "id": "web", "type": "container", "name": "Web app", "technology": "TypeScript, Next.js",
      "description": "Renders the shop and the checkout", "paths": ["apps/web/**"] },
    { "id": "api", "type": "container", "name": "Orders API", "technology": "Rust, Axum",
      "description": "Owns orders and payments", "paths": ["crates/orders-api/**"] },
    { "id": "db", "type": "datastore", "name": "Orders DB", "technology": "PostgreSQL",
      "description": "Stores orders and payment state", "paths": ["crates/orders-api/migrations/**"] },
    { "id": "stripe", "type": "system", "name": "Stripe", "external": true,
      "description": "Takes card payments", "paths": [] }
  ],
  "relationships": [
    { "from": "web", "to": "api", "label": "Places orders through", "technology": "HTTPS, JSON" },
    { "from": "api", "to": "db", "label": "Reads and writes orders in", "technology": "SQL" },
    { "from": "api", "to": "stripe", "label": "Creates charges with", "technology": "HTTPS" }
  ]
}
```

`paths` are globs. The first matching element wins, so list specific paths before broad ones. Keep the map to 15 elements. Split a larger system by container.

## Measure a change

```bash
npx gh-wat-dis impact                    # this branch against the default branch
npx gh-wat-dis impact --working-tree     # include uncommitted work
npx gh-wat-dis impact --base <ref> --head <ref>   # any two commits
npx gh-wat-dis reach <path|path#symbol>  # who depends on this, with no diff
npx gh-wat-dis owners <path>...          # CODEOWNERS for paths
```

**A pull request that already merged.** Measure it between the commit before it and its merge commit. Three steps:

```bash
gh pr list --state merged --limit 1 --json number,title,mergedAt,mergeCommit,commits   # 1. find it: this is "the last merged PR"
git cat-file -e <mergeCommit> || git fetch origin                                      # 2. make sure the local clone holds the merge commit; fetch only when it does not
npx gh-wat-dis impact --base <mergeCommit>~1 --head <mergeCommit>                      # 3. measure it
```

`~1` is right for a squash merge and for a merge commit. A pull request merged by rebase lands as one commit for each of its own commits, so step back that many: `<mergeCommit>~<number of commits>`. Use `gh` for step 1: it reports `mergedAt` and `mergeCommit` together, which is what tells you a pull request merged.

Read the facts in this order:

| Field | Tells you | Goes in |
|---|---|---|
| `elements` with a status | Which parts change, which are only reached | `Change` table, diagram |
| `symbols` with `signatureChanged` | Public interfaces that changed, and who imports them | `Blast radius`, `Risks` |
| `dependents.direct` / `.transitive` | How far the change reaches | `Blast radius` |
| `edges` with `added` / `removed` | New or cut dependencies between elements | `System`, diagram |
| `contracts` | Schemas, migrations, API specs, manifests touched | `Risks`, the alert |
| `tests.importingChanged` | Test files that import the changed modules | `Verify` |
| `coChange` | Files that changed with these before and are not in this diff | `Unknowns` |
| `diagram` | Whether to draw a diagram, at which level, and why: see "When a diagram is needed" | The diagram, and the line you show with the draft |
| `parts` | Commands, tools, skills, routes, jobs, `bin` and `exports` entries and options the change added or removed, with the element that holds each | `Change`, the diagram |
| `complexity` | Functions whose complexity the change moved, with the score before and after. Empty when cccc is not installed | The `diagram` decision and `Blast radius`. Not the body |
| `owners` | Who owns the touched paths | reviewers |
| `tiers`, `caveats` | Which tools ran and what they could not see | wording |

**`coChange`: which pairs to keep.** Most pairs are history noise. Keep one only when the missing file describes, tests or configures the changed file it is paired with: the README for a command, the schema for a query, the test for a module. Open that file and check. Then drop the pair, or list it under `Unknowns` with what you found.

**An element that is not in the map.** An element whose `source` is `git` (a `test` directory, `(root)`, any folder when there is no map and no workspace) is a directory fallback. A fallback that is `added` and holds code draws a diagram as an added element does. Report it as "not in the architecture map". Propose a map entry only when it holds product code.

**`complexity` is an input, not a grade.** Never print a score in an issue or PR, and never call code complex. `impact` uses the numbers in the `diagram` decision: see "When a diagram is needed". When `tiers.unavailable` lists cccc, the numbers are absent: say so only if the user asks, and offer `npx gh-wat-dis doctor --tools install`.

### Answering a question in chat

When the user asks what a change affects and wants no issue or PR, answer in this order and stop where the facts stop:

1. One sentence: what changed, in how many files and which elements, and whether any relationship was added or removed.
2. What it reaches outside the diff: dependents, changed exported signatures, contracts. "Nothing" is an answer.
3. Unknowns: what the tools could not see, and any `coChange` pair you kept.

Use prose and short lists. Do not borrow the sections of a PR body. State an added or removed relationship in a sentence. Draw a diagram for a chat answer only when the user asks for one.

Name the mapped elements first. Then name the ones that are not in the architecture map in one clause, such as "plus tests and root config, which the map does not name".

### Wording follows the label

Every fact names its source tool and one label. The label is the kind of source. It is not a rating.

| Label | Means | Write |
|---|---|---|
| `exact` | Read from git or a file | State it. "3 files change in `crates/core`." |
| `resolved` | An AST parse resolved the reference | State it. "`apps/web/cart.ts` imports `formatPrice`." |
| `measured` | A count over history or the graph | State the number and the window. "Changed with `schema.sql` in 6 of 9 commits, last 90 days." |
| `heuristic` | Inferred from a path or a name | Name the basis. "`tests/` path, treated as a test." |

A tool that did not run produced no fact. Say "not analyzed: <reason>" under `Unknowns`. Do not fill the gap from memory. Languages other than TypeScript, JavaScript and Rust get git-level facts only.

### Questions the tools cannot answer

Ask them of every change that crosses an element boundary, and of a change that adds a call to another system on a relationship that already exists (a new API read, a new query, a new message):

1. Does data cross a new boundary: process, network, trust, team?
2. Does a contract change for a consumer that deploys on its own? Then deploy order matters.
3. Does failure behaviour change: timeouts, retries, partial writes, ordering?
4. Does the change add state, and who owns it?
5. Does it reverse an earlier decision: an ADR, a documented rule?

A yes goes in `Risks` with what the change does about it, or in `Unknowns` with the check that settles it.

## When a diagram is needed

A change to code draws a diagram. A reviewer sees which parts changed and how they connect faster in a picture than in a table, so the diagram is the default and leaving it out needs a reason. `impact` decides from the facts and writes the decision as the fact `diagram`. `blast` prints it on its first line too.

| Field | Says |
|---|---|
| `draw` | `true`: draw one. `false`: leave it out |
| `level` | Which diagram fits: `element`, `code` or `dynamic`. `null` when `draw` is `false` |
| `reasons` | What makes the diagram worth drawing, most specific first: an element or a relationship added or removed, a part added or removed, logic that moved more than a sentence can carry, a changed signature that other files import, calls in a new order. Otherwise "changes code in N elements" |
| `skip` | When `draw` is `false`: why a diagram adds nothing |
| `provenance` | The label of the weakest fact behind the decision. Word the first reason by it, as for any fact |

**When `draw` is `true`**, draw at `level` with the `wat-diagram` skill:

- `element`: `npx gh-wat-dis graph from-facts .wat-tmp/facts.json > .wat-tmp/change.json`. The spec holds the changed and reached elements, both ends of each relationship the change added or removed, and each part from `parts` as a `component` inside the element that holds it, with a line from what calls it. Relabel each generated line with what it does and its technology.
- `code`: `npx gh-wat-dis graph from-facts .wat-tmp/facts.json --level file > .wat-tmp/code.json`. Files are cards, each changed symbol is a row, and a line ends on the symbol a file imports. See "Code level" in the `wat-diagram` skill.
- `dynamic`: write a dynamic spec by hand. The functions the reason names are where the steps are; read them and number the calls in their new order.

State the first reason in one line when you show the draft.

**When `draw` is `false`**, leave the diagram out and state the `skip` reason in one line when you show the draft. The tool skips only the changes a diagram adds nothing to, each measured from the facts:

| `skip` | The facts show |
|---|---|
| only text and documentation changed | Every changed file is docs, prose or generated |
| only dependency and version changes | The other files are manifests and lockfiles |
| only CI, config and text files changed, and no relationship changed | No source changed, and no element, relationship or part came or went |
| only tests changed | Every changed code file is a test |
| only renames | Every changed declaration is one the base had under another name |
| no declaration changed outside comments and layout | The parsed files changed, and no declaration in them did |
| no function gained or lost a branch, no declaration was added or removed, and no relationship changed | Complexity facts are present and list no function |

**A mechanical change** (a codemod, a rename the tools could not pair, the same small edit repeated in many files) can come out as `draw: true`, because its functions moved. Leave the diagram out, write "mechanical" in the opening with the command that reproduces it, and give that as the reason in the line you show with the draft. `lint --facts` warns on a body with no image; for a mechanical change the opening answers it.

**A part** is something a user or another program calls by name: a command, a tool, a skill, an HTTP route, a scheduled job, a `bin` or `exports` entry, or a command's option. `parts` lists each one the change added or removed, with the element that holds it, what calls it when the facts know, and `basis`: where the tools read it (a registry such as `COMMANDS in src/main.ts`, a `SKILL.md`, a manifest field, a route call). A part found by the name of a list or a call is `heuristic`, and `resolved` when the tools followed its handler to a file. An option is not a box in an element diagram: it is a reason, and the code diagram shows it. Offer to add a new part to the map when it will change again.

**Complexity**, when cccc is installed, sets one reason: a function whose cognitive complexity rose by 15 or more, or the listed functions together gaining 40 or more, makes "the logic of ... changed more than a sentence can carry" and the level `code`. A rise is `after.cognitive` minus `before.cognitive`; a new function rises by its whole score; a function renamed with the same body (`renamedFrom`) rises by what its body gained; a removed one counts 0. The reason names the functions, never the score.

Build-time relationships are relationships. An import that exists only for types, a generator that reads a list, or a test that checks a page all count when the change adds or removes them, and `impact` reports them. In an element diagram, draw one only when the change is about it, and name the mechanism in `technology` ("import type", "npm script"). In a code diagram every import the source proves between two drawn files is a line, type-only ones included.

## Choose what to show

| The change | Diagram |
|---|---|
| New external system or new kind of user | System context |
| Adds, removes or rewires a container or data store | Container, with change status |
| Reshapes modules or crates inside one container | Component, for that container only |
| Moves work across a thread, worker or WASM boundary, or changes an ABI or message format | Component, with the execution contexts as nested boundaries |
| Changes the order of calls, adds async steps or retries | Dynamic, numbered steps |
| Changes where things run: regions, nodes, scaling | Deployment |
| A hard change inside one module or a few, or a change whose point is which functions moved, split, appeared or went away (`diagram.level` is `code`) | Code: `graph from-facts --level file`. Files as cards, changed symbols as rows |
| Removes or reorders a parameter of an exported symbol, or changes what it returns, and a file that is not a test imports it | Code: the lines show who imports the symbol. |
| Reworks the order of steps or the state inside one component or file | Dynamic, with that component's own parts as the boxes |
| `diagram.draw` is `false` | None. State the `skip` reason; use a sentence, a `diff` block or a table. |

Show the changed elements and what the change reaches. `graph from-facts` scopes the spec that way, so it needs no `focus` step. Past 8 boxes, use an overview plus a scoped view: see the `wat-diagram` skill.

A change can earn two diagrams: a container or component diagram for the relationship it adds, and a code diagram for the hard part inside one module. Draw the second only when the body would otherwise need a paragraph to say which functions changed.
