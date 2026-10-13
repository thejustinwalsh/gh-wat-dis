# GitHub MCP server by harness

Server: [github/github-mcp-server](https://github.com/github/github-mcp-server). Remote endpoint: `https://api.githubcopilot.com/mcp/`.

`npx gh-wat-dis mcp <client>` prints the current snippet. This file explains the choices.

## Remote or local

| Mode | Use when | Needs |
|---|---|---|
| **Remote** (default) | Almost always. Nothing to run or update. | A token in an environment variable, sent as `Authorization: Bearer`. VS Code signs in with OAuth and needs no token. |
| **Local, Docker** | GitHub Enterprise Server, an air-gapped network, or a pinned server version | Docker, and a token in `GITHUB_PERSONAL_ACCESS_TOKEN` |

OAuth to the remote server works only in hosts that registered a GitHub app (VS Code). The server does not support dynamic client registration, so other hosts use a token.

## Where the token comes from

A harness sends the token to the hosted server in an `Authorization` header on each request. It gets the value in one of three ways.

| Way | Harnesses | Stored where |
|---|---|---|
| **Headers helper**: a command the harness runs at each connect | Claude Code (`headersHelper`) | Nowhere. The helper prints it from the `gh` login. |
| **Own sign-in** | VS Code | In the host's own credential store |
| **Environment variable** named in the config | Codex, Cursor, Gemini CLI, OpenCode, Copilot CLI | Wherever the harness process got its environment |

For the third way, no harness reads a `.env` file by itself. The variable must be in the environment of the harness process. Keep it out of the global shell profile: put it in `.agents/gh-wat-dis/.env`, which `init` git-ignores, and load that file for the project with direnv or mise. The config file only names the variable. It never holds the value.

Do not name the variable `GITHUB_TOKEN` or `GH_TOKEN`. The `gh` CLI reads both and would use them in place of its own login.

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
| Claude Code | `.mcp.json` in the project, or `claude mcp add-json github '<json>' --scope user` | `mcpServers`, with `headersHelper` |
| Codex CLI | `~/.codex/config.toml` | `[mcp_servers.github]` |
| Cursor | `~/.cursor/mcp.json` or `.cursor/mcp.json` | `mcpServers` |
| Gemini CLI | `~/.gemini/settings.json` or `.gemini/settings.json` | `mcpServers`, with `httpUrl` |
| OpenCode | `~/.config/opencode/opencode.json` or `opencode.json` | `mcp`, with `"type": "remote"` and `"oauth": false` |
| VS Code, Copilot Chat | `.vscode/mcp.json` | `servers` |
| Copilot CLI | its MCP config | `mcpServers`, with `"type": "http"` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers`, with `serverUrl`. No environment expansion: the user edits the token in by hand. |
| Claude Desktop | `claude_desktop_config.json` | `mcpServers`. Local Docker only. |

## One-click install links

Some harnesses register a link that opens their own "add this MCP server" screen with the config filled in. The user clicks, reads the config, and confirms. `npx gh-wat-dis mcp cursor` and `mcp vscode` print the link.

| Harness | Link | Carries |
|---|---|---|
| Cursor | `https://cursor.com/en/install-mcp?name=github&config=<base64 JSON>` | The server entry, base64-encoded |
| VS Code | `https://insiders.vscode.dev/redirect/mcp/install?name=github&config=<URL-encoded JSON>` | The server entry, URL-encoded |
| Claude Code | None for MCP. `claude-cli://open?q=<prompt>` opens a session with a prompt filled in, so a link can ask the agent to run the setup. | A prompt, not a config |
| Codex, Gemini CLI, OpenCode | None | Use the CLI or the config file |

A link never carries a token. The config in it names an environment variable.

## Rules

1. Merge into the file. Keep every other server and setting.
2. Never write the token value into a config file. Use the headers helper, or name an environment variable.
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
