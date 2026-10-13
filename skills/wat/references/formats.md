# Formats

## The opening

Every issue and PR opens with plain prose: a sentence or two that says what the problem is and how we solve it. No label, no heading. A reader who stops there knows why the work exists and what it does about it.

- State the problem so a person outside the conversation follows it: the element, the behaviour, the effect.
- State the solution in the same breath. In a PR it is what was done. In an issue it is what we intend to do.
- When the solution is not known, say so, and spend the words on the problem: the exact symptom, where it shows, what you ruled out. `Unknowns` is then the main section.
- Do not restate the title. Do not describe the diff ("updates three files").

> Four services each validate tokens, and two disagree on expiry, so a session can be valid in one and expired in another. This moves validation into the API gateway and removes it from the services.

## Structure serves substance

A section exists because it has something true to say. Leave out any section that would hold filler, and never add a label, table or list to make a body look complete. A three-sentence issue for a small task is correct. Prose is the right form for reasoning; tables and lists are for comparisons, sequences and sets.

When you use a section, use its name and its place in the order below, so readers learn where to look. Omit every section that has nothing true to say.

Aim for a visible body of about 60 lines for an issue, 80 for a PR, 15 for a milestone. These are targets, not limits. A hard design needs more words than a typo fix. Long data goes in **Agent context**; reasoning a human needs stays visible.

## Issue

```markdown
<Opening: the problem and how we intend to solve it, in a sentence or two of plain prose. If the solution is not known, say so and make the problem sharp.>

> [!WARNING]
> <Only if one thing blocks or breaks. Else omit.>

![<Diagram title>](./<name>.svg)

## System
<1 to 3 sentences. Which elements and relationships this touches, and why the design goes this way.>
<Optional: one scoped diagram for the part that changes, with its legend table.>

## Change
| Element | Today | After |
|---|---|---|
| <name from the architecture map> | <behaviour now> | <behaviour then> |

## Do
- [ ] <one bounded action, verb first>
- [ ] <5 at most; more means sub-issues>

## Risks
- **<Pitfall>**: <what breaks, when> → <how to avoid or detect it>

## Evidence
- <measurement, log line, permalink, failing test, user report: each with a link or a command>

## Unknowns
- <question> → <the check or the person that settles it>

<details>
<summary>Agent context</summary>

<paths, symbols, commands, impact facts, long logs, reproduction scripts, links read>

</details>
```

**By issue type**

Pick the type by what is wrong: **Bug** when the system does something other than what it should. **Feature** when it cannot do something yet. **Task** for everything else, including missing or wrong documentation, cleanup, releases and checks.

"Usually omit" means: leave the section out unless it holds a fact the reader needs. When the facts are the whole case, keep it. A section the row does not name follows the general rule: use it when it has something true to say.

| Type | The opening states | Must have | Usually omit |
|---|---|---|---|
| Bug | The wrong behaviour, where it shows, expected vs actual | `Evidence` with expected vs actual and a reproduction; `System` names the failing element | `Change` until the cause is known |
| Feature | What users or the system cannot do today, and what that costs | `System`, `Change`, `Do` | — |
| Task / chore | What is out of date, missing or in the way, and the element it sits in | `Do` | Diagram, `System`, `Evidence` |
| Spike / research | The decision that is blocked, and what is not known | `Unknowns` as the main section, a time limit in `Do` | `Change` |
| Tracking issue | The gap between the system today and the goal | `System` with a diagram; work as **sub-issues**, not checkboxes | `Do` |

## Pull request

```markdown
<Opening: the problem and how this PR solves it, in a sentence or two of plain prose. A reader who never saw the issue must follow it.>

> [!WARNING]
> <Only for a breaking change, a migration, or a required deploy order. Else omit.>

![<Diagram title>](./<name>.svg)

## System
<1 to 3 sentences. The design decision and the reason. Name the option you rejected if a reviewer would ask.>

## Change
| Element | Change | Why |
|---|---|---|
| <name> | <what is different> | <reason> |

## Blast radius
<Only when the change reaches past its own diff. Output of `npx gh-wat-dis blast`, trimmed to what a reviewer would act on: code outside the diff that depends on the change, changed exported signatures, contracts, tests, files that usually change with these.>

## Verify
- [x] <check you ran, with the command and the result>
- [ ] <check the reviewer runs: one command or one click path>

## Risks
- **<Pitfall>**: <what breaks, when> → <mitigation or rollback>

## Evidence
<before / after table, benchmark numbers, screenshots, test output: short>

## Unknowns
- <what you did not check> → <how to check it>

## Follow-ups
- #<n> <title>: <why it is not in this PR>

<details>
<summary>Agent context</summary>

<impact facts JSON, file list, commands run, logs>

</details>

Closes #<n>
Refs #<m>
```

- Write an image as `![Title](./file.svg)` with the local path. `gh --attach` uploads the file and puts its GitHub URL in place of the path.
- Before / after images go in a 2-column table.
- Link lines go last, after the agent block, one issue per line.
  - `Closes #n`: the issue closes when the PR merges. Use it only for an issue this PR finishes.
  - `Refs #n`: a link with no effect on state. Use it for a tracking issue, a related issue, or an issue this PR only partly covers.
  - Between two issues, use GitHub's relations and not a `Refs` line: a parent for "part of", blocked by for "must wait for".
- Never put `close`, `fix` or `resolve` in front of an issue number anywhere else in the body or in a commit message. GitHub ignores the words around the keyword: "does not fix #12" closes #12.
- `Follow-ups` lists issues that already exist. File them first. Omit the section when there are none.
- A PR that changes no element, relationship or contract (typo, dependency bump, formatting) keeps only: the opening, `Verify`, link lines.
- Name a file as a link when the reader should open it and it is not in the diff. `blast` prints its paths as links for this.

## Link lines

In an issue as in a pull request, `Refs #n` lines go last, after the Agent context block, one for each line. Do not put them inside `Evidence`. Between two issues, prefer a real relation: a parent, or blocked by.

## Milestone

GitHub renders only basic Markdown in milestone descriptions. Use plain text, bold, lists and links. No alerts, no `<details>`, no Mermaid, no images.

```markdown
<Goal: one sentence. What users or the system can do when this ships. No date.>

**Done when**
- <condition that names its check: a command and its output, a URL and its status, or an issue number>
- <3 at most>

**In scope:** <elements or capabilities>
**Out of scope:** <the thing people will assume is included>
**Tracking:** #<tracking issue>
```

Rich content (diagram, risk table, status) lives in the **tracking issue**: an issue with the milestone's issues as its sub-issues. See the `wat-milestone` skill.

## Status comment (milestone or epic)

```markdown
**<Moving | Blocked | Stalled | Done>**: <one sentence, the reason from the tool>

| | Count |
|---|---|
| Closed | <n> of <total> |
| In review | <n> |
| Blocked | <n> |

**Done when**
- [x] <condition> (<evidence>)
- [ ] <condition> (<what is missing, or "not checked">)

**Decides the outcome**
- #<n> <title>: <what it blocks, or which condition needs it>

**Changed since last update**
- <3 at most, or "First status.">

**Needs a decision**
- <question> → @<the issue's assignee, else the repository owner>
```

The numbers come from `npx gh-wat-dis milestone`. Counts are issues only: pull requests and the tracking issue are not counted. There is no schedule rating, because milestones have no due dates. Omit `Needs a decision` when there is none.

## Diagrams

GitHub draws a body about 860px wide. A wider image is scaled down and its text shrinks, and a taller one makes the reader scroll to follow a line. So prefer small diagrams.

| Diagram | Where | Size to aim for |
|---|---|---|
| **Overview**: the system with groups folded to boxes | Right after the opening | 6 boxes or fewer |
| **Scoped view**: one group opened, its neighbours folded | In `System`, or in the section that discusses that part | 8 boxes or fewer |
| **Flow**: numbered steps, left to right | Where the behaviour is described: `Change`, `Risks` or `Verify` | 8 steps or fewer |

- The box counts are aims for a diagram in a body. A whole-system view the user asked for keeps every container when the renderer reports that it fits 860px.
- Use one diagram when it fits. Use an overview plus a scoped view when one diagram would pass 8 boxes. Three is the limit for a visible body.
- Each diagram sits next to the words it supports. Do not stack them at the top.
- When lines carry numbers, put the legend table directly under the image. The table holds the words: the reader can search, copy and link them.
- A second or third diagram that only some readers need goes in a `<details>` block with a summary that says what it shows.

## Agent context

One block, last in the body, collapsed. Humans skip it. Agents read it first.

Put here: full impact facts (`npx gh-wat-dis impact`), file and symbol lists, exact commands and their output, long logs, reproduction scripts, links you read, constraints for whoever picks the work up. Use fenced code blocks with a language tag. Keep the whole body under 60,000 characters.

Do not put here: anything a human reviewer must read to approve. That belongs above.
