---
name: wat
description: Entry point and house rules for GitHub project management. Use before you create, edit, review or report on GitHub issues, pull requests or milestones, when you triage a backlog, or when the user mentions gh-wat-dis. Checks the repo policy in .agents/gh-wat-dis/config.json, then routes to the right gh-wat-dis skill.
license: MIT
---

# wat

gh-wat-dis writes GitHub issues, pull requests and milestones for a busy engineering team. Every artifact answers five questions fast: what the problem is, how we solve it, what changes in the system, what can go wrong, what proof exists.

## 1. Check the repo policy first

Read `.agents/gh-wat-dis/config.json` at the repository root.

| State | Do |
|---|---|
| File exists, `policy.use` is `always` | Use gh-wat-dis. Do not ask. |
| File exists, `policy.use` is `ask` | Ask once per session, then follow the answer. |
| File exists, `policy.use` is `never` | Stop. Work without gh-wat-dis. |
| File does not exist | Ask the user: use gh-wat-dis once, configure this repo (`npx gh-wat-dis init`), or skip. |

The config also holds the project defaults: labels, issue types, milestone naming, the architecture map. Config values win over the defaults in these skills.

## 2. Route

| Task | Skill |
|---|---|
| Install or repair the GitHub MCP server, `gh`, or the repo config | `wat-setup` |
| Create or edit an issue | `wat-issue` |
| Open or edit a pull request | `wat-pr` |
| Create, plan or report on a milestone | `wat-milestone` |
| Sort new issues, set type and surface labels, define labels, propose milestones | `wat-triage` |
| Stale issues, label hygiene, duplicates, milestone rollover | `wat-maintain` |
| Understand or map the system, measure change impact | `wat-architecture` |
| Make an SVG diagram and attach it | `wat-diagram` |

## 3. Rules for every artifact

1. **Problem, then solution.** Know both before you write. Open every issue and PR with a sentence or two of plain prose: what the problem is and how we solved it or intend to. No label, no heading. If nobody knows the solution yet, say so, and make the problem clear at once. Never write a body whose problem you cannot state.
2. **Design first.** State how the work changes the system: which elements, which relationships, which contracts. A body with no system statement is not done. When no element, relationship or contract changes, the statement is one sentence that names the element the work sits in and says nothing changes. It can sit in the opening: do not add a `System` section for it. A Task is the usual case: its opening names the element, and that is its system statement.
3. **Facts only.** Take paths, symbols, counts and dependents from `npx gh-wat-dis impact`, the diff, or a file you read. Never invent a version, line number, flag or metric. Mark what you did not check as an unknown.
4. **Consistent shape, no filler.** Use the section names and order in [references/formats.md](references/formats.md), and only the sections that have something to say. Structure without substance is noise: a short body in plain sentences beats a full template of thin sections.
5. **Plain language.** Follow [references/style.md](references/style.md).
6. **Small diagrams, when the change is hard to follow.** The measure is complexity, not size: see "When a diagram is needed" in [../wat-architecture/SKILL.md](../wat-architecture/SKILL.md). A hard change inside one file gets a diagram. A formatting pass across the repository gets none. Use `wat-diagram`. One diagram when it fits GitHub's width at a readable size; an overview plus a scoped view when it does not.
7. **Agent context goes last.** Long data for agents sits in one collapsed `<details>` block at the end, as a single code block that starts with a leading prompt. A person can open it, copy it and paste it into any agent.
8. **Clear beats short.** The formats and limits are guides for a reader in a hurry. When a limit would cut a fact, a condition or the reason for a decision, keep the words. A body the reader cannot follow has failed, however short it is.
9. **Backstop check before you post.** Run `npx gh-wat-dis lint <file> --kind issue|pr|milestone`. It catches only what GitHub would break and gross shape errors. Passing it does not mean the body is good: these skills decide that.
10. **Show the draft, then write.** Posting to GitHub is public. Show the user the body and wait for a yes, unless `policy.confirmBeforeWrite` is `false`.

## 4. Answering in chat

When the user asks a question and wants no issue, PR or comment, answer in prose: the answer first, then the facts behind it, then what you could not check. Do not borrow the sections of a body. A skill that has its own chat shape says so.

## 5. Stay in lane

gh-wat-dis decides how to communicate: the shape, the words, the diagram, the fields. It does not decide how the team builds software.

- Coding style, test policy, branch rules, review rules and commit format come from the repository: its `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, templates and config. Follow them. Do not add your own.
- Analysis tools collect and check facts for the text you write. Do not turn their output into a review, a score or a verdict.
- Never write "safe", "ready", "clean" or "looks good". State what changed, what it reaches and what you verified.

## 6. Tools

- **Write with `gh`.** Create and edit issues, PRs, comments and milestones with the GitHub CLI. Only `gh` can upload attachments (`--attach`, needs gh 2.99.0 or later).
- **Read with the GitHub MCP server.** Search, list, read threads, diffs and check runs. If the server is not connected, use `gh` for reads too and suggest `wat-setup`. Where a step shows a `gh` read command, that is the fallback: the matching MCP tool is the first choice. The exception is a read the server cannot do: milestones, a search by `updated:<DATE`, `linked:pr` or `is:blocked`, and a PR's closing references. Use `gh` first for those. Where a step names an `npx gh-wat-dis` tool, use that tool and do not rebuild its output from raw reads.
- **Measure with `npx gh-wat-dis`.** `impact`, `diagram`, `related`, `links`, `lint`. The package carries everything these commands need. Never ask a project to install another tool for them.

Scratch files go in `.wat-tmp/`. Check it first and never overwrite a file you did not write: see "Scratch files" in the command map.

Command map: [references/tools.md](references/tools.md). What GitHub renders and where: [references/rendering.md](references/rendering.md).
