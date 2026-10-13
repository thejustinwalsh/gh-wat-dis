# GitHub MCP server by harness

Server: [github/github-mcp-server](https://github.com/github/github-mcp-server). Remote endpoint: `https://api.githubcopilot.com/mcp/`.

`npx gh-wat-dis mcp <client>` prints the current snippet. This file explains the choices.

## Remote or local

| Mode | Use when | Needs |
|---|---|---|
| **Remote** (default) | Almost always. Nothing to run or update. | A token in an environment variable, sent as `Authorization: Bearer`. VS Code signs in with OAuth and needs no token. |
| **Local, Docker** | GitHub Enterprise Server, an air-gapped network, or a pinned server version | Docker, and a token in `GITHUB_PERSONAL_ACCESS_TOKEN` |

OAuth to the remote server works only in hosts that registered a GitHub app (VS Code). The server does not support dynamic client registration, so other hosts use a token.

## Toolsets

Default toolsets: `context`, `repos`, `issues`, `pull_requests`, `users`. gh-wat-dis adds `labels`.

| Setting | Remote | Local |
|---|---|---|
| Toolsets | header `X-MCP-Toolsets: default,labels` | `GITHUB_TOOLSETS=default,labels` |
| Read-only | header `X-MCP-Readonly: true`, or URL suffix `/readonly` | `GITHUB_READ_ONLY=1` |
| Lockdown (hide content from users without push access, public repos) | header `X-MCP-Lockdown: true` | `GITHUB_LOCKDOWN_MODE=1` |

gh-wat-dis writes through `gh`, so **read-only is a good default** for the MCP server. It lowers the risk from text inside issues that tries to instruct the agent. Use lockdown on public repos for triage and maintenance.

## Config files

| Client | File | Key |
|---|---|---|
| Claude Code | `claude mcp add-json github '<json>' --scope user`, or `.mcp.json` in the project | `mcpServers` |
| Codex CLI | `~/.codex/config.toml` | `[mcp_servers.github]` |
| Cursor | `~/.cursor/mcp.json` or `.cursor/mcp.json` | `mcpServers` |
| Gemini CLI | `~/.gemini/settings.json` or `.gemini/settings.json` | `mcpServers`, with `httpUrl` |
| OpenCode | `~/.config/opencode/opencode.json` or `opencode.json` | `mcp`, with `"type": "remote"` and `"oauth": false` |
| VS Code, Copilot Chat | `.vscode/mcp.json` | `servers` |
| Copilot CLI | its MCP config | `mcpServers`, with `"type": "http"` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers`, with `serverUrl`. No environment expansion: the user edits the token in by hand. |
| Claude Desktop | `claude_desktop_config.json` | `mcpServers`. Local Docker only. |

## Rules

1. Merge into the file. Keep every other server and setting.
2. Reference the token by environment variable. Never write the token value.
3. If a `github` entry exists, show it and ask before you change it.
4. Project-scope files (`.mcp.json`, `.cursor/mcp.json`) are shared with the team. Ask before you add one to a repository.
5. After the change, the user restarts the harness. Check with `get_me`.

## Problems

| Symptom | Cause | Fix |
|---|---|---|
| 401 from the remote server | Variable not set in the harness's environment, or the token expired | Set it in the shell profile, restart the harness |
| Tools missing | Classic token lacks the scope; the server hides tools it cannot serve | Add the scope, or enable the toolset |
| "does not support dynamic client registration" | The host tried OAuth | Use the token snippet |
| Write tools open a form in VS Code | MCP Apps is on | Expected. gh-wat-dis writes through `gh`. |
| Milestone tools not found | The server has none | gh-wat-dis uses `gh api` for milestones |
