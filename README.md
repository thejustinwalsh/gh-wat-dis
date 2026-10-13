# gh-wat-dis

Agent skills that write GitHub issues, pull requests and milestones a busy engineer can act on in two minutes: the problem and the solution first, the system design next, the long data for agents folded away at the end.

It ships as one npm package: nine skills, plus small tools the skills call through `npx`. A project installs nothing.

## Install

Say this to your coding agent:

> Run `npx gh-wat-dis install`, then tell me how to use it.

That is the whole thing.

## If you are the coding agent reading this

1. Run `npx gh-wat-dis install`. It copies the `wat` skills to `~/.agents/skills` and `~/.claude/skills`, then runs every check. Add `--project` to install into this repository only.
2. Read the check lines. Fix each `FAIL` it prints. `warn` lines are optional.
3. If `gh auth` fails, the sign-in needs a person and a browser. Ask the human to run `npx gh-wat-dis doctor` in their own terminal: it offers to sign in, then checks again. Do not run the sign-in for them.
4. The GitHub MCP server is optional: the skills read through `gh` without it. If the human wants it, ask whether to set it up for every repository or only this one, then run `npx gh-wat-dis mcp --apply --scope user` (or `--scope project`). Never ask for a token in chat. Never write a token into a file.
5. In a repository that should always use these skills, run `npx gh-wat-dis init`, review `.agents/gh-wat-dis/config.json` with the human, and commit it.
6. Tell the human to restart the harness so the skills load.
7. Explain "Use it" below.

Do not edit the installed skill directories. `install` owns them and will not overwrite your edits without `--force`.

## What you need

| Need | Why |
|---|---|
| Node 24 or later (or Bun, or Deno) | Runs `npx gh-wat-dis` |
| GitHub CLI 2.99 or later, signed in | Every write goes through `gh`. `--attach` uploads diagrams. |
| GitHub MCP server (optional) | Reads and search. Skills fall back to `gh` without it. |

## Use it

Ask in plain words. The skills trigger on the task.

| You say | Skill |
|---|---|
| "File an issue for the duplicate charge bug" | `wat-issue` |
| "Open a PR for this branch" | `wat-pr` |
| "Plan the v1.4 milestone" / "Where are we on v1.4?" | `wat-milestone` |
| "Triage the new issues" | `wat-triage` |
| "Run a backlog cleanup" | `wat-maintain` |
| "What does this change affect?" / "Map the architecture" | `wat-architecture` |
| "Draw the container diagram for checkout" | `wat-diagram` |
| "Set up gh-wat-dis" | `wat-setup` |

Every issue and PR:

- opens with the problem and how it is solved, in a plain sentence
- states what changes in the system, with one diagram when structure changes
- takes its claims about code from tools, each fact labeled with its source
- lists risks, evidence and what is still unknown
- keeps long data for agents in one collapsed block at the end

The agent shows you the draft before it posts.

## Repo policy

`.agents/gh-wat-dis/config.json` settles whether agents use these skills in a repository, and holds its defaults.

| `policy.use` | Agents |
|---|---|
| `always` | Use the skills without asking |
| `ask` | Ask once per session |
| `never` | Do not use them |
| no config file | Ask before the first use, and offer `init` |

The file also holds issue types, priority labels, milestone naming and capacity, and the architecture map that gives every issue and PR the same names for the same parts of the system.

## Tools

Each tool does one thing. Data goes out as JSON on stdout, so tools chain. `-` or piped stdin stands in for a file.

| Tool | Does |
|---|---|
| `impact` | Collects facts on what a change touches and reaches. TypeScript, JavaScript and Rust get symbol-level analysis. |
| `reach <path\|symbol>` | Lists who depends on a file or symbol. No diff needed. |
| `owners <path>` | Resolves CODEOWNERS. |
| `elements` | Lists architecture elements and the files they map. |
| `related` | Finds issues and PRs that share signals with a draft. |
| `links` | Shows what a PR will close on merge and what it only mentions. |
| `graph <op>` | Reshapes a diagram spec: `from-facts`, `focus`, `collapse`, `drop`, `merge`, `diff`, `set`, `rename`, `stats`, `ids`. |
| `diagram` | Lints a C4 diagram spec and renders an SVG. |
| `blast` | Formats impact facts as a Markdown section. |
| `lint` | Backstop: catches what GitHub would break in a body. |
| `install`, `uninstall`, `init`, `mcp`, `doctor` | Set up and check. |

```bash
npx gh-wat-dis impact \
  | npx gh-wat-dis graph from-facts \
  | npx gh-wat-dis graph focus --on status:changed,added,removed --hops 1 \
  | npx gh-wat-dis diagram -o change.svg
```

Facts carry a label that names their source: `exact` (read from git or a file), `resolved` (an AST parse resolved it), `measured` (a count over history or the graph), `heuristic` (inferred from a path or name). The tools report. They do not score or give verdicts.

## What this is not

It is not a code review tool, and it does not set your team's engineering practice. Coding style, test policy and branch rules come from your repository. gh-wat-dis decides how the work is communicated.

## When something is wrong

Run `npx gh-wat-dis doctor`.

| Symptom | Cause | Fix |
|---|---|---|
| `FAIL gh` | GitHub CLI older than 2.99 | `brew upgrade gh`, or https://cli.github.com |
| `FAIL gh auth` | Not signed in, or the saved token expired | Run `npx gh-wat-dis doctor` in your terminal and accept the sign-in |
| `FAIL skills` | Not installed, or a directory `install` does not own | `npx gh-wat-dis install` (`--force` to replace) |
| Skills do not trigger | Harness not restarted | Restart it |
| Image shows as a broken link | The file was not attached | Post with `gh ... --attach <file>` and check the body has an `https://` image URL |

## Update and remove

```bash
npx gh-wat-dis@latest install
```

```bash
npx gh-wat-dis uninstall
```

## Credits

The writing style adapts [attention-control](https://github.com/aaddrick/attention-control). Diagrams follow the [C4 model](https://c4model.com) and are laid out by [elkjs](https://github.com/kieler/elkjs). Code facts come from [ast-grep](https://ast-grep.github.io). See `NOTICE.md`.

MIT licensed.
