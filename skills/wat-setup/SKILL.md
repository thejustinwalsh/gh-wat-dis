---
name: wat-setup
description: Set up gh-wat-dis. Installs the wat skills into the user's agent harness, connects the GitHub MCP server (Claude Code, Codex, Cursor, Gemini CLI, OpenCode, GitHub Copilot, VS Code, Windsurf), checks the GitHub CLI, and writes the repo config at .agents/gh-wat-dis/config.json. Use when the user asks to install, set up, configure, update, repair or uninstall gh-wat-dis or the GitHub MCP server, when `npx gh-wat-dis doctor` reports a failure, or when a wat skill finds no repo config and the user chooses to configure.
license: MIT
---

# wat-setup

Four parts. `install` runs every check when it ends, and `doctor` runs the same checks on their own. Each prints one `ok`, `warn` or `FAIL` line for each part. Fix only what fails.

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

Then walk the user through the choices. Ask only what the repo does not answer.

| Key | Question | Default |
|---|---|---|
| `policy.use` | Use gh-wat-dis for every issue, PR and milestone in this repo? | `always` |
| `policy.confirmBeforeWrite` | Show each draft before posting? | `true` |
| `issues.types` | None to ask. `init` reads the GitHub issue types of an organization repository (`typeSource: issue-type`). A repository under a user account has none, so `init` sets `typeSource: label` with Task, Bug, Feature, and `labels apply` creates those labels. | From GitHub, else Task, Bug, Feature |
| `labels.surfaces` | Which parts of the product should issues be labeled with? Run `npx gh-wat-dis labels --text` for a proposal from the architecture map, agree the list, save it, then `npx gh-wat-dis labels apply`. | One per mapped element |
| `milestones.naming` | How are milestones named? | Pattern of existing titles |
| `milestones.capacity` | How many issues fit one milestone? | Unset |
| `pulls.draft` | Open PRs as drafts? | `false` |
| `architecture` | Map the system now? | Offer the `wat-architecture` skill |

Commit the config. It is the team's shared policy: with it in the repo, no agent asks whether to use gh-wat-dis.

## Report

End with the `npx gh-wat-dis doctor` output and one line: what the user must do next, if anything (restart the harness, set the token variable, run `gh auth login`).
