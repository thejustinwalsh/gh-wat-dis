---
name: wat-milestone
description: Create, plan, track and close GitHub milestones. Writes a short milestone description plus a tracking issue with a system diagram, reports status from the milestone tool (counts, what is in review, what is blocked, done-when conditions), and proposes scope cuts. Milestones run in sequence with no due dates. Use when the user asks to create or plan a milestone or release, asks "where are we on <milestone>", wants a status update or burndown, or wants to close or roll over a milestone.
license: MIT
---

# wat-milestone

Policy check first: follow section 1 of the `wat` skill (`../wat/SKILL.md`). Style: `../wat/references/style.md`. Commands: `../wat/references/tools.md`. Shapes: `../wat/references/formats.md`.

A milestone has two parts. The **description** is 15 lines of plain Markdown: goal, done-when, scope. The **tracking issue** carries the rich view: diagram, risks, sub-issues, status comments.

## Create

1. **Read the defaults** in `.agents/gh-wat-dis/config.json` → `milestones` (naming, capacity). List open milestones to avoid a clash. Milestones run in sequence: the new one is the next version after the highest that exists. Do not set a due date.
2. **Get the goal** in one sentence. If the user gives a list of features, ask what a user or the system can do when it ships.
3. **Write done-when conditions.** 3 at most. Each one names its own check, so that anyone can run it later: the command and what it prints, the URL and the status it returns, or the issue or pull request that shows it. "The site is live" is not checkable. "`https://example.com/` returns 200" is.
4. **Draft** `.wat-tmp/milestone.md` in the Milestone format. Run the backstop: `npx gh-wat-dis lint .wat-tmp/milestone.md --kind milestone`. It catches the elements a milestone description cannot render.
5. **Show the draft**, wait for a yes, then create:
   ```bash
   gh api repos/{owner}/{repo}/milestones -f title="<title>" -F description=@.wat-tmp/milestone.md
   ```
6. **Create the tracking issue** with the `wat-issue` skill, in the new milestone. Its `System` section holds a container diagram with status `added` / `changed` for what the milestone delivers. Make each member issue a sub-issue of it: `npx gh-wat-dis relate <n> --parent <tracking>`. Then put its number in the description's `Tracking` line.

## Plan scope

1. List candidates: open issues with no milestone that match the goal, plus what the user names.
   - **When the user asks what is left to do**, open issues are not the whole list. Check each done-when condition against the repository: run the check it names, read the code and docs for work that is promised and not done, and run `npx gh-wat-dis doctor`. Verify a gap before you list it: a suspected problem that the check does not confirm is not a candidate.
   - Show each gap as a proposed issue: title, type, surface, size, and the fact that shows it. File them with the `wat-issue` skill after the user agrees.
2. For each one, read type, labels, size, dependencies.
3. Fill the milestone to `milestones.capacity` (issues or points, from the config). No capacity set: use the count closed in the last finished milestone.
4. Order by dependency: blockers first. Flag any issue blocked by work outside the milestone.
5. Show one table: `Issue | Why it belongs | Size | Blocked by`. Then a short "Not in" list with the reason. Apply after a yes: `gh issue edit <n> --milestone "<title>"`, and record each blocker with `npx gh-wat-dis relate <n> --blocked-by <m>`.

## Report status

1. **Get the numbers from the tool.** Do not count or compute them yourself.
   ```bash
   npx gh-wat-dis milestone            # the current milestone
   npx gh-wat-dis milestone "<title>"  # a named one
   ```
   It prints JSON. Use it as given:

   | Field | Meaning |
   |---|---|
   | `milestone.current` | True for the lowest open version: the one that is due now |
   | `tracking`, `trackingFrom` | The tracking issue. `description`: the milestone names it on a `Tracking:` line. `sub-issues`: the tool guessed it as the issue with the most sub-issues. |
   | `counts.total`, `closed`, `open` | Issues only. Pull requests and the tracking issue are not counted. |
   | `counts.inReview` | Open issues with an open pull request that closes them. This is the format's "In review" row. |
   | `counts.blocked`, `blockedOutside` | Open issues with an open blocker, and how many of those wait on something outside the milestone. `blocked` is the format's "Blocked" row. |
   | `counts.closedLast7Days`, `daysSinceLastClose` | How recently work closed |
   | `open[]` | Each open issue with `inReview` (pull request numbers) and `blockedBy` (number, title, `inMilestone`) |
   | `closed[]` | Each closed issue with its close time, newest first |
   | `status`, `reason` | `done`, `blocked`, `stalled` or `moving`, and the one fact behind it |
   | `doneWhen` | The conditions from the milestone description |

   When `trackingFrom` is `sub-issues`, say so in one line and propose adding `**Tracking:** #<n>` to the milestone description.

2. **Check each done-when condition.** Run the check it names. Mark it met or not met, with the evidence.
   - **You cannot run the check here** (a clean machine, a production system): mark it "not checked", say why, and give the nearest fact you can measure, labeled as indirect. An open issue that delivers the condition is such a fact.
   - **The condition names no check:** say what you looked at, and propose wording that names one.
   - **The condition has several parts** (a command, a place to run it, a source for the package): check each part you can, and report each one. The condition is met only when every part is checked and met. One part you could not check makes the whole condition "not checked", with the parts you did check listed as facts.
   - Never mark a condition met from an indirect fact.
3. **Find what changed.** Read the comments on the tracking issue (`issue_read` with `get_comments`, or `gh issue view <tracking> --comments`). The last status comment is the baseline. No earlier status: write "First status."
4. **Name the 1 to 3 issues that decide the outcome**: the ones that block others, or that a done-when condition needs. They go in the format's "Decides the outcome" list.
5. **Write** the Status comment format from `../wat/references/formats.md`. If `status` is `blocked` or `stalled`, propose what to do: which issue to unblock, or which issues move to the next milestone and what this one still delivers.
6. **Show it in chat.** A status the user only asked to see needs no file: write it in the reply. When the user asks to post it, save it to your task folder, check it with `npx gh-wat-dis lint <file> --kind comment`, and post it as a comment on the tracking issue.

### Status has no dates

Milestones here have no due dates, and a date never sets importance. The current milestone is the lowest open version, and it is always due now. So the status says whether work moves, not whether it is on schedule:

| Status | The tool reports it when |
|---|---|
| `done` | Every issue is closed |
| `blocked` | An open issue waits on something outside the milestone, or every open issue waits on another |
| `stalled` | No issue closed in 7 days and no pull request is open |
| `moving` | None of the above |

Never ask the user for a due date, and never propose one.

## Close or roll over

1. List open issues in the milestone. For each: finish, move to the next milestone, or drop to the backlog. Give a one-line reason. Show the table and wait for a yes.
2. Move issues, then close: `gh api -X PATCH repos/{owner}/{repo}/milestones/<number> -f state=closed`.
3. Post a final status comment on the tracking issue: what shipped against each done-when condition, what moved and why. Close the tracking issue.

Closing a milestone and moving issues change shared state. Never do either without a yes for that exact list.
