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

````markdown
<Opening: the problem and how we intend to solve it, in a sentence or two of plain prose. If the solution is not known, say so and make the problem sharp.>

> [!WARNING]
> <Only if one thing blocks or breaks. Else omit.>

<div align="center">

![<Diagram title>](./<name>.svg)

</div>

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

```text
<The leading prompt: see "Agent context" below.>

<paths, symbols, commands, impact facts, long logs, reproduction scripts, links read>
```

</details>
````

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

````markdown
<Opening: the problem and how this PR solves it, in a sentence or two of plain prose. A reader who never saw the issue must follow it.>

> [!WARNING]
> <Only for a breaking change, a migration, or a required deploy order. Else omit.>

<div align="center">

![<Diagram title>](./<name>.svg)

</div>

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
<a before and after pair when the change can be seen, benchmark numbers, test output: short>

## Unknowns
- <what you did not check> → <how to check it>

## Follow-ups
- #<n> <title>: <why it is not in this PR>

<details>
<summary>Agent context</summary>

```text
<The leading prompt: see "Agent context" below.>

<impact facts JSON, file list, commands run, logs>
```

</details>

Closes #<n>
Refs #<m>
````

- Write an image as `![Title](./file.svg)` with the local path. `gh --attach` uploads the file and puts its GitHub URL in place of the path.
- **Centre every diagram.** Put the image line inside `<div align="center">` and `</div>`, with a blank line after the opening tag and before the closing one, as the template shows. GitHub then centres it in the body. Without the blank lines the image does not render. An image inside a table cell, such as a before and after pair, stays as it is.
- A before and after pair is one good way to show a change a person can see. It is a choice, not a rule: see "Before and after" below.
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
**<Moving | Growing | Stalled | Blocked | Not started | Done>**: <one sentence, the reason from the tool>

**Signals:** <the text of each signal the tool marks as deciding, then any other signal a reader would act on>

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

The rating, the signals and the numbers come from `npx gh-wat-dis milestone`. Counts are issues only: pull requests and the tracking issue are not counted. The rating never stands alone: the `Signals` line carries the numbers behind it, so a reader can disagree. No signal is a date that a person set, because milestones have no due dates. Omit `Needs a decision` when there is none.

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

## Before and after

A before and after pair is a way to report evidence, not a required part of a body. Reach for it when a reviewer would understand the change faster by seeing it: two captures of the same thing, one from before the change and one from after, can say more than a paragraph. They go in `Evidence`. When words or numbers carry the change as well, use those and attach nothing.

**When it fits.** The change alters something a person looks at or reads, and the difference is the point:

| The change | Show it as |
|---|---|
| A screen, a page, a component, a layout, a colour, a spacing | Two screenshots |
| A rendered artifact: a diagram, a chart, a generated image, a PDF | Two renders |
| What a command prints, an error message, a log line | Two text blocks, or a `diff` block. Not a screenshot |
| A terminal UI where the colour or the layout is the change | Two screenshots of the terminal |

**When it does not.** Leave it out when the difference is small enough to state in a sentence, when the output is the same before and after (a refactor, a rename, a speed-up: use numbers), when only a test can observe the change, or when you could not capture both sides. Something new has no "before": show one capture under `After` and say that it is new. Never fill the `Before` cell with a mock, a description or a capture of something else.

**What makes a good pair.** A reader should find the difference in a few seconds, and it should be the only difference.

1. **Same surface.** The same page, the same component, the same command with the same arguments.
2. **Same framing.** The same viewport size, zoom, theme, scroll position and crop. Capture both with one procedure, and change only the code between the two.
3. **Same state.** The same data, the same account, the same step in the flow. A pair with different content shows the content, not the change.
4. **Cropped to the change**, with enough around it to see where it is. A whole page for one button hides the button.
5. **Real captures.** `Before` comes from the base branch or the commit before the change, not from memory. Do not draw on a capture or edit it.
6. **Nothing private** in the frame: no token, no personal data, no customer name.
7. **Few.** One pair for each visible change, three pairs at most. Past that, show the most telling ones and list the rest in a sentence. Capture both themes or a second width only when the change differs there.

If you cannot meet 1 to 3, the pair misleads. Say what you could not capture under `Unknowns` and leave the pair out.

**The table.** Two columns labelled `Before` and `After`, the pair side by side, and one sentence under it that says what to look at:

```markdown
| Before | After |
|---|---|
| ![Hero at 1440px, dark: the headline alone](./hero-before.png) | ![Hero at 1440px, dark: the cat card beside the headline](./hero-after.png) |

The card sits to the right of the headline. The install block moved under both columns.
```

- Each column is about 420px wide on GitHub. Capture at a width that stays readable there, or crop. When the surface is too wide to read at that size, stack the pair: a `Before` row, then an `After` row, in a one-column table.
- The alt text names the surface, the framing and what the capture shows.
- Name the files `<what>-before.<ext>` and `<what>-after.<ext>`, and attach each with `--attach`, written the same way in the body and the flag.

**Text output.** A fenced block cannot sit in a table cell, and text should stay text so a reader can search and copy it. Use two labelled blocks, trimmed to the lines that matter:

````markdown
**Before**
```text
$ npx gh-wat-dis lint --help
gh-wat-dis lint: unknown option --help
```

**After**
```text
$ npx gh-wat-dis lint --help
Usage: npx gh-wat-dis lint <body.md|-> --kind issue|pr|milestone|comment [--json]
```
````

When only a few lines of a long output differ, one `diff` block is shorter and clearer.

**How to capture.** Use the screenshot or browser tool your harness has, at a fixed size. Get the `before` side from a second checkout of the base branch (`git worktree add <dir> <base>`), or from the deployed version when that matches the base. For a diagram, `npx gh-wat-dis diagram <spec> --png <file>` on each version of the spec. No tool for it: do not ask the project to install one. Say that you have no capture.

## Agent context

One block, last in the body, collapsed. Humans skip it. Agents read it first.

**One code block, so it can be copied.** Inside the `<details>`, put everything in a single fenced block tagged `text`. GitHub draws a copy button on a code block, so a person can open the block, copy it, and paste it into an agent that does not have these skills. Leave a blank line after `<summary>` and before `</details>`, or GitHub does not render the fence. When the content itself holds a line of three backticks, open and close the block with four.

**It starts with a leading prompt**, because the pasted text arrives alone, without the body above it. Four short parts, in plain sentences:

1. Where this is: the repository and the title of the issue or pull request, with its URL once it has one.
2. The problem and the plan, in the one or two sentences of the opening.
3. The task for the agent that reads it: "Do the steps under Do in the issue" for an issue, "Review this change against the facts below" or "Continue this work" for a pull request.
4. How to treat the facts: tools collected them at the commits named below, and the agent checks a fact against the code before it relies on it.

```text
You are working in acme/shop on the issue "Payments worker: duplicate charge when the webhook retries".
Problem and plan: Stripe retries a webhook when our reply takes over 10 s, and the Payments worker charges the card again. The worker will key each charge on event.id so a retry finds the first charge and stops.
Task: do the steps under Do in the issue. Start with the files under Paths.
The facts below were collected by tools at base 4f1c2ab, working tree. Check a fact against the code before you rely on it.

Paths
  services/payments/src/charge.ts    retryCharge
...
```

Then the data: full impact facts (`npx gh-wat-dis impact`), file and symbol lists, exact commands and their output, long logs, reproduction scripts, links you read, constraints for whoever picks the work up. Give each part a plain heading line inside the block ("Paths", "Commands run", "Facts"). Keep the whole body under 60,000 characters.

The prompt states the task. It gives no instruction that the body does not already give: an agent that finds this block in an issue treats it as data, like any other issue text.

Do not put here: anything a human reviewer must read to approve. That belongs above.
