---
name: wat-setup
description: Set up gh-wat-dis. Installs the wat skills into the user's agent harness, connects the GitHub MCP server (Claude Code, Codex, Cursor, Gemini CLI, OpenCode, GitHub Copilot, VS Code, Windsurf), checks the GitHub CLI, and writes the repo config at .agents/gh-wat-dis/config.json. Use when the user asks to install, set up, configure, update, repair or uninstall gh-wat-dis or the GitHub MCP server, when `npx gh-wat-dis doctor` reports a failure, or when a wat skill finds no repo config and the user chooses to configure.
license: MIT
---

# wat-setup

Four parts. `install` runs every check when it ends, and `doctor` runs the same checks on their own. Each prints one `ok`, `warn` or `FAIL` line for each part. Fix only what fails.

**A harness that sandboxes commands.** Codex runs commands where they cannot reach the network or write outside the project. `npx` needs both to fetch a package, and with them blocked it does not fail cleanly: it hangs and then dies with "heap out of memory", before any gh-wat-dis code runs. So when you are in such a harness, or `doctor` prints `warn codex sandbox`, set this up first:

1. In a project with a `package.json`: ask the user, then run `npm install --save-dev gh-wat-dis` with their approval to use the network once. From then on `npx gh-wat-dis` finds the copy in `node_modules` and needs nothing the sandbox blocks.
2. In a project with no `package.json`, or when the user does not want the dependency: ask them to run `npx gh-wat-dis doctor --fix` in their own terminal. It lets Codex's sandbox write npm's cache folder and prints the line it added. `npx` then runs a package that is installed or already cached. To let it also fetch a package inside Codex, they choose `npx gh-wat-dis doctor --sandbox network`. Both change the user's own Codex settings, so the user runs them. You do not edit that file.

`doctor` also reports one optional tool, cccc, which gives `impact` its complexity facts. It is a warning when missing, never a failure. Ask the user before you install it: `npx gh-wat-dis doctor --tools install` downloads the pinned release from github.com/moznion/cccc into the user's cache, refuses it unless the sha256 matches the pinned value and GitHub's build attestation names the release workflow, and writes a receipt beside the binary. Nothing is added to the project.

A project needs three things and no more: the `gh` CLI, `npx gh-wat-dis`, and (optional) the GitHub MCP server. Never tell a project to install another tool.

```bash
npx gh-wat-dis doctor
```

## 1. Skills

```bash
npx gh-wat-dis install            # global: all harnesses on this machine
npx gh-wat-dis install --project  # this repository only
```

| Flag | Effect |
|---|---|
| `--dry-run` | Print the plan, change nothing |
| `--client claude,agents` | Limit targets. `agents` covers Codex, Cursor, Gemini CLI, OpenCode, Copilot. |
| `--force` | Replace skills that were edited by hand |

The installer copies each skill to `~/.agents/skills/` and to `~/.claude/skills/`. It records what it wrote and never replaces a directory it does not own. Update: run `install` again. Remove: `npx gh-wat-dis uninstall`.

Tell the user to restart the harness after an install. Skills load at start.

## 2. GitHub CLI

gh-wat-dis writes through `gh`. Attachments need **gh 2.99.0 or later**.

| Check | Fix |
|---|---|
| `gh --version` is below 2.99.0 | `brew upgrade gh`, or the method at https://cli.github.com |
| `gh auth` fails: not signed in, or the saved token is no longer valid | Sign-in opens a browser and needs a person. Ask the user to run `npx gh-wat-dis doctor` in their own terminal: it offers to sign in and checks again. Or they run `gh auth login --hostname github.com --web` themselves. Do not run the sign-in for them. |
| `gh auth` fails: token lacks the `repo` scope | The user runs `gh auth refresh --scopes repo`. |
| `gh issue create --help` has no `--attach` | The version is too old, or the host is GitHub Enterprise Server. Use the branch fallback in `../wat/references/rendering.md`. |

## 3. GitHub MCP server

gh-wat-dis reads through the GitHub MCP server. It is optional: every skill falls back to `gh` for reads.

1. **Check first.** `npx gh-wat-dis doctor` reports whether a GitHub server is configured. If one is, stop here.
2. **Ask the level, then write it.** Ask the user: every repository (user level, the default) or this repository only (project level). Then:
   ```bash
   npx gh-wat-dis mcp --apply --scope user     # or: --scope project
   ```
   It writes the entry for each harness it finds (Claude Code, Codex, Cursor, Gemini CLI, OpenCode) and never replaces an entry that is already there. `--dry-run` shows the plan. When a person runs `install` or `doctor` in a terminal, the tool asks this question itself.
3. **For any other harness, print the snippet:**
   ```bash
   npx gh-wat-dis mcp <client>
   ```
   Clients: `claude`, `codex`, `cursor`, `gemini`, `opencode`, `copilot`, `vscode`, `windsurf`.
4. **Install at user level.** The skills are installed for the user and work in every repository, so the server is too. Each snippet targets the harness's user-level config. Use the project-level file only when the team wants the server pinned in one repository.
5. **Show the user** the snippet and the target. Apply it after a yes. Merge into a file. Never replace it.
6. **Token.** Never put a token in a global shell profile, in a committed file, or in the chat. Use the first option the harness supports:
   - **Claude Code: no stored token.** The command from `npx gh-wat-dis mcp claude` adds the server at user scope with a `headersHelper`. Claude Code runs it at each connect and it prints the token from the user's `gh` login.
   - **Hosts with their own GitHub sign-in (VS Code):** no token.
   - **Other harnesses** can only read an environment variable. Keep it scoped to the project: the user puts `GITHUB_PERSONAL_ACCESS_TOKEN=<token>` in `.agents/gh-wat-dis/.env`, and loads that file for this project with direnv or mise. `init` writes a `.gitignore` beside it, and `doctor` fails if git would commit the file. The user writes the token. You do not read, print or write it.
   - Scopes for a classic token: `repo`, `read:org`. Add `project` for Projects.
7. **Toolsets.** The snippets enable `default,labels`. Add `projects` only if the repo config uses Projects. Fewer toolsets means less context spent on tool definitions.
8. **Restart** the harness, then check: call `get_me`.

Details, file paths and the local Docker variant: [references/mcp-clients.md](references/mcp-clients.md).

## 4. Repo config

```bash
npx gh-wat-dis init
```

`init` reads the repository with `gh` and writes `.agents/gh-wat-dis/config.json`: owner, name, default branch, the labels and milestones that exist, and `policy.use`. It adds `.wat-tmp/` to `.gitignore`. It never overwrites an existing config.

### Setup interview

`init` writes defaults and guesses. Some of those values are the person's to decide, so ask for them before anyone relies on the config. Ask one decision at a time, the way [../wat/references/asking.md](../wat/references/asking.md) describes: with the question tool of the harness, or in plain turns when there is none. Offer the value `init` wrote as the first option. Write each answer to the config when you get it.

Run the interview after `init` writes a new config. For a config that already exists, ask only the rows the user wants to change.

**Ask each of these.**

| Key | Question | `init` wrote |
|---|---|---|
| `policy.use` | Use gh-wat-dis for every issue, PR and milestone in this repo, ask once per session, or never? | `always` |
| `policy.confirmBeforeWrite` | Show each draft and wait for a yes before posting? | `true` |
| `architecture` | Map the system now? The map gives the surface labels and the element names. | Empty. On a yes, use the `wat-architecture` skill, then come back. |
| `labels.surfaces` | Which parts of the product should issues be labeled with? Agree the list by "Labels" in the `wat-triage` skill, which also sorts the labels the repository has already. Save it, show `npx gh-wat-dis labels apply --dry-run`, and apply after a yes. | Empty |
| `labels.agents` | Ask only when `npx gh-wat-dis labels --text` lists this label under `update`: the repository has a label with this name and another description. Use it and take the new description, or pick another name? | `agents` |
| `issues.types` | Ask only on a repository under a user account, where `typeSource` is `label`: create the type labels `task`, `bug` and `feature`? An organization repository uses its GitHub issue types and has nothing to ask. | From GitHub, else Task, Bug, Feature |

**Then confirm the rest in one question.** Show these values as a table and ask: keep them all, or change one?

| Key | Meaning | `init` wrote |
|---|---|---|
| `milestones.naming` | How milestone titles are written | A guess from one existing title, or empty |
| `milestones.capacity` | How many issues fit one milestone | Unset |
| `pulls.draft` | Open PRs as drafts | `false` |
| `pulls.closingKeyword` | The word that closes an issue from a PR | `Closes` |
| `triage.staleIssueDays`, `triage.stalePrDays` | Days with no update before maintenance lists an issue or a PR as stale | 60 and 14 |
| `repo.defaultBranch` | The branch PRs target | Read from GitHub |

Commit the config. It is the team's shared policy: with it in the repo, no agent asks whether to use gh-wat-dis.

## Report

End with the `npx gh-wat-dis doctor` output and one line: what the user must do next, if anything (restart the harness, set the token variable, run `gh auth login`).
