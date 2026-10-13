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
| `focused.json` | `whole-system.json` cut down to the change by the pipeline below. |

## Redraw

```sh
for f in context container change-impact dynamic whole-system focused; do
  npx gh-wat-dis diagram examples/diagrams/$f.json
done
```

## How `focused.json` was made

```sh
npx gh-wat-dis graph focus --on status:changed,added,removed --hops 1 examples/diagrams/whole-system.json \
  | npx gh-wat-dis graph collapse --to-type container \
  | npx gh-wat-dis graph set --type container \
      --title "Payment retries move to idempotency keys" --scope "the payment retry change" \
  > examples/diagrams/focused.json
npx gh-wat-dis diagram examples/diagrams/focused.json
```

`focus` keeps the five changed, added and removed components, their neighbours one hop away, and the
containers and system that hold them. `collapse` folds each container's components into the container
and merges their relationships. `set` renames the result. 27 elements become 5.

Inspect a spec before choosing a filter:

```sh
npx gh-wat-dis graph stats examples/diagrams/whole-system.json
npx gh-wat-dis graph ids examples/diagrams/whole-system.json | grep -v unchanged
```
