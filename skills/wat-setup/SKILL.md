---
name: wat-setup
description: Set up gh-wat-dis. Installs the wat skills into the user's agent harness, connects the GitHub MCP server (Claude Code, Codex, Cursor, Gemini CLI, OpenCode, GitHub Copilot, VS Code, Windsurf), checks the GitHub CLI, and writes the repo config at .agents/gh-wat-dis/config.json. Use when the user asks to install, set up, configure, update, repair or uninstall gh-wat-dis or the GitHub MCP server, when `npx gh-wat-dis doctor` reports a failure, or when a wat skill finds no repo config and the user chooses to configure.
license: MIT
---

# wat-setup

Four parts. `install` runs every check when it ends, and `doctor` runs the same checks on their own. Each prints one `ok`, `warn` or `FAIL` line for each part. Fix only what fails.

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
| `gh auth status` fails | The user runs `gh auth login` in their own terminal. Do not run it for them. |
| `gh issue create --help` has no `--attach` | The version is too old, or the host is GitHub Enterprise Server. Use the branch fallback in `../wat/references/rendering.md`. |

## 3. GitHub MCP server

gh-wat-dis reads through the GitHub MCP server. It is optional: every skill falls back to `gh` for reads.

1. **Check first.** Look for a `github` server in the harness (`claude mcp list`, or the config file in [references/mcp-clients.md](references/mcp-clients.md)). If one is connected, stop here.
2. **Print the snippet** for the harness:
   ```bash
   npx gh-wat-dis mcp <client>
   ```
   Clients: `claude`, `codex`, `cursor`, `gemini`, `opencode`, `copilot`, `vscode`, `windsurf`.
3. **Show the user** the snippet and the target file. Apply it after a yes. Merge into the file. Never replace it.
4. **Token.** Every snippet reads the token from an environment variable. Hosts with their own GitHub sign-in (VS Code) need no token.
   - The user creates the token and sets the variable themselves. Never ask them to paste a token into the chat. Never write a token into a file.
   - Scopes for a classic token: `repo`, `read:org`. Add `project` for Projects.
   - Fastest path for a user who already ran `gh auth login`: `export GITHUB_PERSONAL_ACCESS_TOKEN="$(gh auth token)"` in their shell profile. Tell them this reuses the CLI's token.
5. **Toolsets.** The snippets enable `default,labels`. Add `projects` only if the repo config uses Projects. Fewer toolsets means less context spent on tool definitions.
6. **Restart** the harness, then check: call `get_me`.

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
| `issues.types` | Which issue types, and are they GitHub issue types or labels? | From the repo |
| `issues.priorities` | Which priority labels? | From the repo, else none |
| `milestones.naming` | How are milestones named? | Pattern of existing titles |
| `milestones.capacity` | How many issues fit one milestone? | Unset |
| `pulls.draft` | Open PRs as drafts? | `false` |
| `architecture` | Map the system now? | Offer the `wat-architecture` skill |

Commit the config. It is the team's shared policy: with it in the repo, no agent asks whether to use gh-wat-dis.

## Report

End with the `npx gh-wat-dis doctor` output and one line: what the user must do next, if anything (restart the harness, set the token variable, run `gh auth login`).
