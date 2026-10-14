# Example diagrams

One system throughout: a checkout platform with a TypeScript web app and Rust services.
Each `.json` is a diagram spec (`src/spec.ts`). Each `.svg` beside it is what `diagram` drew from it.

| Spec | Shows |
| --- | --- |
| `context.json` | System context: people and systems only. |
| `container.json` | Containers inside the platform boundary, with a data store, a queue and external systems. |
| `change-impact.json` | A change, using every status: added, changed, removed, affected, unchanged. |
| `dynamic.json` | A dynamic diagram: relationships carry `order` and render as numbered steps. |
| `whole-system.json` | 27 elements at component level. Too big to read in a pull request; `diagram` warns about it. |
| `focused.json` | The diagram of the issue on the site: the Payments worker and the Orders database change, and the Orders API is affected. Top down, so it stays readable on a phone. |
| `code.json` | A code diagram of the same change: files as cards, a row for each symbol the change touched, lines that end on the symbol a file imports. `graph from-facts --level file` writes one from impact facts. |

## Redraw

```sh
for f in context container change-impact dynamic whole-system focused code; do
  npx gh-wat-dis diagram examples/diagrams/$f.json
done
```

## Cutting a large map down to the change

```sh
npx gh-wat-dis graph focus --on status:changed,added,removed --hops 1 examples/diagrams/whole-system.json \
  | npx gh-wat-dis graph collapse --to-type container \
  | npx gh-wat-dis diagram -o change.svg
```
