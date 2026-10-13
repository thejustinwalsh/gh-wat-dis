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

1. **Find the runtime units.** A container is something that must run for the system to work: a web app, an API, a worker, a CLI, a database, a queue, a bucket. Look for entry points and deploy config, not folders:
   - TypeScript: `package.json` workspaces, `bin`, `main`, `exports`, `scripts.start`
   - Rust: `Cargo.toml` workspace members, `[[bin]]` targets, `src/main.rs`, `cdylib` crates that build WebAssembly
   - Any: `Dockerfile`, `docker-compose.yml`, `Procfile`, Kubernetes and Terraform files, serverless config, CI deploy jobs
   - Connection strings and client constructors for data stores, queues and third-party APIs
2. **Find the people and external systems.** Who calls in (users, other teams' systems, webhooks) and what the code calls out to (payment, email, auth providers).
3. **Find components only where work happens.** A component is a group of code behind one interface: a module with a public entry file, a library crate. Map components for the containers that change often. Skip the rest.
4. **Name relationships by intent and protocol.** "Reads orders from [SQL]", "Publishes OrderPlaced to [Kafka]". Never a bare "uses".
5. **Check against the code.** Run `npx gh-wat-dis elements` to see which files each element maps and which files are unmapped. Run `npx gh-wat-dis impact --base <an older ref>` and compare `edges` with your relationships. An import edge the map lacks is a missing relationship. Add it or ask the user.
6. **Show the user** a container diagram (`wat-diagram`) and the element list. Save the map only after a yes.

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
npx gh-wat-dis reach <path|path#symbol>  # who depends on this, with no diff
npx gh-wat-dis owners <path>...          # CODEOWNERS for paths
```

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
| `owners` | Who owns the touched paths | reviewers |
| `tiers`, `caveats` | Which tools ran and what they could not see | wording |

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

Ask them of every change that crosses an element boundary:

1. Does data cross a new boundary: process, network, trust, team?
2. Does a contract change for a consumer that deploys on its own? Then deploy order matters.
3. Does failure behaviour change: timeouts, retries, partial writes, ordering?
4. Does the change add state, and who owns it?
5. Does it reverse an earlier decision: an ADR, a documented rule?

A yes goes in `Risks` with what the change does about it, or in `Unknowns` with the check that settles it.

## Choose what to show

| The change | Diagram |
|---|---|
| New external system or new kind of user | System context |
| Adds, removes or rewires a container or data store | Container, with change status |
| Reshapes modules or crates inside one container | Component, for that container only |
| Changes the order of calls, adds async steps or retries | Dynamic, numbered steps |
| Changes where things run: regions, nodes, scaling | Deployment |
| Stays inside one component, no contract change | None. Use a `diff` block or a table. |

One diagram per artifact. Show the changed elements plus one hop of neighbours. 12 elements at most.
