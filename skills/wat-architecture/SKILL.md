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
| `complexity` | Functions whose complexity the change moved, with the score before and after. Empty when cccc is not installed | The diagram and `Blast radius` decisions. Not the body |
| `owners` | Who owns the touched paths | reviewers |
| `tiers`, `caveats` | Which tools ran and what they could not see | wording |

**`coChange`: which pairs to keep.** Most pairs are history noise. Keep one only when the missing file describes, tests or configures the changed file it is paired with: the README for a command, the schema for a query, the test for a module. Open that file and check. Then drop the pair, or list it under `Unknowns` with what you found.

**An element that is not in the map.** An element whose `source` is not `config` (a `test` directory, `(root)`) is a directory fallback. Report it as "not in the architecture map". Propose a map entry only when it holds product code.

**`complexity` is an input, not a grade.** Never print a score in an issue or PR, and never call code complex. Use the numbers to decide what the reader needs: see "When a diagram is needed". When `tiers.unavailable` lists cccc, the numbers are absent: say so only if the user asks, and offer `npx gh-wat-dis doctor --tools install`.

### Answering a question in chat

When the user asks what a change affects and wants no issue or PR, answer in this order and stop where the facts stop:

1. One sentence: what changed, in how many files and which elements, and whether any relationship was added or removed.
2. What it reaches outside the diff: dependents, changed exported signatures, contracts. "Nothing" is an answer.
3. Unknowns: what the tools could not see, and any `coChange` pair you kept.

Use prose and short lists. Do not borrow the sections of a PR body. State an added or removed relationship in a sentence. Draw a diagram for a chat answer only when the user asks for one, or when the test under "When a diagram is needed" says the change cannot be followed without it.

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

The measure is how hard the change is to follow, not how much it touches. A change inside one file can need a diagram. A change across twenty modules can need none.

**Draw one** when the change alters how parts relate, at any level, down to the functions of one module:
- Parts are added, removed or rewired: what calls, owns or depends on what.
- The order of steps changes, or steps become async, retried or conditional.
- State is added or moves: a new state, a new owner, new transitions.
- The shape of data that crosses a boundary changes: a contract, a message, a stored format.

**Do not draw one**, however many files or elements change, when the parts relate as they did before: formatting, a rename, a codemod, a dependency bump, text and documentation, the same small edit repeated in many places, new values in an unchanged flow.

**With complexity facts** (`complexity` and `summary.complexity` from `impact`, present when cccc is installed), start from the numbers:

| The facts show | Then |
|---|---|
| An element or a relationship has status `added` or `removed` (`elements`, `edges`) | Draw one, whatever the complexity numbers say. A new part or a new connection is a change to the structure, and small functions can make it. Check this row first. |
| No function moved (`functions` is 0) | The flow did not change. No diagram for the logic, however many files changed. |
| Every rise in cognitive complexity is under 5, and the first row does not apply | Small edits to existing flows. A sentence covers it. |
| One function rose by 15 or more, or the listed functions together gained 40 or more | The change is hard to follow from the diff. Open the functions at the top of `complexity` and apply the test below to them: this is where a component or dynamic diagram earns its place. |
| Between those | Apply the test below. |

The numbers point at where to look. The test decides.

**The test:** say what is different in the structure or the flow. If the answer names three or more parts and how they connect, or an order of steps, draw it. If one plain sentence covers it ("adds a flag to `lint`", "renames the field everywhere"), write the sentence and skip the diagram.

Draw at the level where the difficulty sits. For a hard change inside one module, that is a component or dynamic diagram of that module's own parts, not a container diagram with one changed box.

## Choose what to show

| The change | Diagram |
|---|---|
| New external system or new kind of user | System context |
| Adds, removes or rewires a container or data store | Container, with change status |
| Reshapes modules or crates inside one container | Component, for that container only |
| Moves work across a thread, worker or WASM boundary, or changes an ABI or message format | Component, with the execution contexts as nested boundaries |
| Changes the order of calls, adds async steps or retries | Dynamic, numbered steps |
| Changes where things run: regions, nodes, scaling | Deployment |
| Reworks the flow or state inside one component or file | Component or dynamic, with that component's own parts as the boxes |
| Passes none of the tests above, whatever its size | None. Use a sentence, a `diff` block or a table. |

Show the changed elements plus one hop of neighbours. Past 8 boxes, use an overview plus a scoped view: see the `wat-diagram` skill.
