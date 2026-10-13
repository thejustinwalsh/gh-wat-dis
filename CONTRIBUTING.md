# Contributing

## Code

- **Erasable TypeScript.** Source is `.ts` that Node 24, Bun and Deno run as written: `node src/bin.ts <command>`. Nothing is bundled.
- **Publish strips types.** Node will not strip types for files under `node_modules`, so `npm pack` runs `tsc` first (`prepack`). It writes one `.js` per `.ts` into `dist/` and rewrites the import extensions.
- **Erasable syntax only.** No `enum`, no `namespace`, no parameter properties, no decorators. `tsconfig.json` sets `erasableSyntaxOnly`.
- **Import with the `.ts` extension** and use `import type` for types.
- **Type check:** `npm run typecheck`. **Test:** `npm test` (`node --test`, tests are `.ts` too).
- **Dependencies:** Node built-ins, `elkjs`, `@ast-grep/napi`, `@ast-grep/lang-rust`. A consuming project must never install another tool to run a command.

## Tools

Each command does one thing and composes with the others.

- **Data out is JSON on stdout.** Progress and errors go to stderr. Exit 0 when the command ran, 1 when it found a failure, 2 for a usage error.
- **Data in is a file argument or stdin** (`-`, or no argument when stdin is piped).
- **One shared shape per kind of data.** Graphs are a diagram spec (`src/spec.ts`). Change facts are `Facts` (`src/impact/types.ts`). A tool that makes a graph writes a spec; a tool that draws one reads a spec. No tool both decides the shape and renders it.
- **Every option that shapes output is a flag or a filter the agent can chain.** If an agent would need to edit a tool's output by hand to get the right result, add a filter.
- **Facts carry a provenance label** (`exact`, `resolved`, `measured`, `heuristic`) and a source. Tools report. They do not score, rank quality or give verdicts.

## Lane

gh-wat-dis decides how to communicate in issues, pull requests and milestones. It does not review code or set a team's engineering practice. Analysis exists to make the words accurate.
