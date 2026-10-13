---
name: wat-diagram
description: Make a system design diagram as an SVG and attach it to a GitHub issue, PR or comment. Writes a small JSON spec of C4 elements and relationships with optional change status (added, changed, removed, affected), lints it against C4 notation, renders it with ELK layout, and uploads it with gh --attach. Use when the user asks for an architecture, context, container, component, sequence or before/after diagram, or when another wat skill calls for one.
license: MIT
---

# wat-diagram

Policy check first: follow section 1 of the `wat` skill (`../wat/SKILL.md`). Which diagram type: the `wat-architecture` skill (`../wat-architecture/SKILL.md`).

A diagram earns its place when it shows structure that a sentence cannot. One per artifact. 12 elements at most.

## Steps

1. **Pick the type and scope.** One level per diagram: context, container, component, dynamic or deployment.
2. **Get the elements.**
   - From a change: `npx gh-wat-dis impact --diagram .wat-tmp/change.json`, then edit the spec.
   - From the map: copy elements and relationships from `.agents/gh-wat-dis/config.json` → `architecture`.
   - From neither: read the code. Never draw an element you did not find.
3. **Write the spec** to `.wat-tmp/<name>.json`.
4. **Render.**
   ```bash
   npx gh-wat-dis diagram .wat-tmp/<name>.json -o .wat-tmp/<name>.svg
   ```
   Fix every lint error. Fix warnings unless the fact is not known; then say so in the body under `Unknowns`.
5. **Look at it.** Open the SVG or a rasterized copy. Check that no label overlaps a box and that the changed elements stand out. If it reads as a hairball, cut elements or split the diagram.
6. **Reference it** in the body by its local path. The alt text is the diagram title:
   ```markdown
   ![Checkout: payment retries move to a worker](./<name>.svg)
   ```
   Write the path relative to the body file. Put the diagram right after the opening and the alert.
7. **Attach on post.** `gh issue create|edit --body-file <body> --attach <svg>` or `gh pr create|edit ...`. `gh` uploads the file and swaps the local path for the uploaded URL. Check the posted body: the image link must start with `https://`.

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
| `parent` | id of a `boundary`, `node` or `system` element: nests the element inside it |
| `external` | `true` for anything the team does not own |
| `status` | `added`, `changed`, `removed`, `affected` (reached, not modified). Omit for unchanged. |
| relationship `order` | Step number on a `dynamic` diagram |

## Rules

- **Names match the architecture map**, letter for letter. The body and the diagram use the same words.
- **Every relationship has a label** that says what moves or happens, in the direction of the arrow. Never "uses" or "calls". Container-to-container lines name the protocol in `technology`.
- **Status carries the change.** One diagram shows before and after: `removed` for what goes, `added` for what comes. Do not draw two diagrams.
- **Descriptions stay under 60 characters.** The body holds the detail.
- **Show one hop.** Changed elements plus their direct neighbours. Leave out the rest of the system.
- **A dynamic diagram has 8 steps at most.** Longer flows go in a numbered list.
- The renderer adds the title, the subtitle and the key. Do not repeat them in the body.

## Options

| Need | Command |
|---|---|
| Check a spec only | `npx gh-wat-dis diagram spec.json --lint-only` |
| Force a palette | `--theme light` or `--theme dark` (default `auto` follows the reader's system) |
| Two files for a `<picture>` tag | `--theme split` writes `.light.svg` and `.dark.svg` |
| Mermaid text, no file | `npx gh-wat-dis diagram spec.json --mermaid` |

Use the Mermaid output only where an attachment is not possible: a milestone tracking comment from a tool with no `gh`, or a repo on GitHub Enterprise Server.

## Updating a diagram

Edit the spec, render again, and edit the body with the new file: `gh issue edit <n> --body-file <body> --attach <svg>`. Keep the spec in the Agent context block as a `json` code block so the next agent can change it.
