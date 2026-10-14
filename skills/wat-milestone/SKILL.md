---
name: wat-milestone
description: Create, plan, track and close GitHub milestones. Writes a short milestone description plus a tracking issue with a system diagram, reports status from the milestone tool (a rating with the measured signals behind it, counts, what is in review, what is blocked, done-when conditions), and proposes scope cuts. Milestones run in sequence with no due dates. Use when the user asks to create or plan a milestone or release, asks "where are we on <milestone>", wants a status update or burndown, or wants to close or roll over a milestone.
license: MIT
---

# wat-milestone

Policy check first: follow section 1 of the `wat` skill (`../wat/SKILL.md`). Style: `../wat/references/style.md`. Commands: `../wat/references/tools.md`. Shapes: `../wat/references/formats.md`.

A milestone has two parts. The **description** is 15 lines of plain Markdown: goal, done-when, scope. The **tracking issue** carries the rich view: diagram, risks, sub-issues, status comments.

## Create

1. **Read the defaults** in `.agents/gh-wat-dis/config.json` → `milestones` (naming, capacity). List open milestones to avoid a clash. Milestones run in sequence: the new one is the next version after the highest that exists. Do not set a due date.
2. **Get the goal** in one sentence. If the user gives a list of features, ask what a user or the system can do when it ships.
3. **Write done-when conditions.** 3 at most. Each one names its own check, so that anyone can run it later: the command and what it prints, the URL and the status it returns, or the issue or pull request that shows it, written as its full URL (`https://github.com/<owner>/<repo>/issues/<n>`). An issue filed for the new milestone has no URL yet: name it in words now, and put its URL in when you add the `Tracking` line in step 6. GitHub links a full URL in a milestone description and does not link `#<n>`. "The site is live" is not checkable. "`https://example.com/` returns 200" is.
4. **Draft** `.wat-tmp/milestone.md` in the Milestone format. Run the backstop: `npx gh-wat-dis lint .wat-tmp/milestone.md --kind milestone`. It catches the elements that break on the milestone page or in the milestones list, and each issue written as `#<n>` where the full URL belongs.
5. **Show the draft**, wait for a yes, then create:
   ```bash
   gh api repos/{owner}/{repo}/milestones -f title="<title>" -F description=@.wat-tmp/milestone.md
   ```
6. **Create the tracking issue** with the `wat-issue` skill, in the new milestone. Its `System` section holds a diagram with status `added` / `changed` for what the milestone delivers, at the level where those changes sit: a container diagram when containers change, a component diagram when the changes are inside one container (see "When a diagram is needed" in `wat-architecture`). Make each member issue a sub-issue of it: `npx gh-wat-dis relate <n> --parent <tracking>`. Then edit the description: put the full URL of each issue its conditions name, and the tracking issue's full URL in the `Tracking` line: `**Tracking:** https://github.com/<owner>/<repo>/issues/<n>`.

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
   | `tracking`, `trackingFrom` | The tracking issue. `description`: the milestone names it on a `Tracking:` line, as a full URL (`#<n>` is read too). `sub-issues`: the tool guessed it as the issue with the most sub-issues. |
   | `counts.total`, `closed`, `open` | Issues only. Pull requests and the tracking issue are not counted. |
   | `counts.inReview` | Open issues with an open pull request that closes them. This is the format's "In review" row. |
   | `counts.blocked`, `blockedOutside` | Open issues with an open blocker, and how many of those wait on something outside the milestone. `blocked` is the format's "Blocked" row. |
   | `counts.closedLast7Days`, `daysSinceLastClose` | How recently work closed |
   | `open[]` | Each open issue with `inReview` (pull request numbers) and `blockedBy` (number, title, `inMilestone`) |
   | `closed[]` | Each closed issue with its close time, newest first |
   | `rating`, `reason` | `done`, `not started`, `blocked`, `stalled`, `growing` or `moving`, and the one fact behind it. The rules are in "The rating has no dates" below. |
   | `signals[]` | Every number behind the rating: `name`, `value`, `text` (the number as a sentence) and `decides` (true for the signals the rule used). `value` is null when the tool could not measure it. |
   | `doneWhen` | The conditions from the milestone description |

   When `trackingFrom` is `sub-issues`, say so in one line and propose adding `**Tracking:** https://github.com/<owner>/<repo>/issues/<n>` to the milestone description.

2. **Check each done-when condition.** Run the check it names. Mark it met or not met, with the evidence.
   - **You cannot run the check here** (a clean machine, a production system): mark it "not checked", say why, and give the nearest fact you can measure, labeled as indirect. An open issue that delivers the condition is such a fact.
   - **The condition names no check:** say what you looked at, and propose wording that names one.
   - **The condition has several parts** (a command, a place to run it, a source for the package): check each part you can, and report each one. The condition is met only when every part is checked and met. One part you could not check makes the whole condition "not checked", with the parts you did check listed as facts.
   - Never mark a condition met from an indirect fact.
3. **Find what changed.** Read the comments on the tracking issue (`issue_read` with `get_comments`, or `gh issue view <tracking> --comments`). The last status comment is the baseline. No earlier status: write "First status."
4. **Name the 1 to 3 issues that decide the outcome**: the ones that block others, or that a done-when condition needs. They go in the format's "Decides the outcome" list.
5. **Write** the Status comment format from `../wat/references/formats.md`. The rating never stands alone: the first line gives the word and `reason`, and the `Signals` line gives the `text` of each signal with `decides: true`, plus any other signal a reader would act on (an issue reopened, a blocker that is weeks old, scope added). Copy the numbers. Do not add a judgement the signals do not carry.
   - `blocked` or `stalled`: propose what to do. Name the issue to unblock, or the issues that move to the next milestone and what this one still delivers.
   - `growing`: list the issues that joined in the last 7 days (the newest in `open[]`) and propose which of them move to the next milestone.
   - `not started` on a milestone where `milestone.current` is false: this is the normal state of a later milestone. Report it in one line and propose nothing.
6. **Show it in chat.** A status the user only asked to see needs no file: write it in the reply. When the user asks to post it, save it to your task folder, check it with `npx gh-wat-dis lint <file> --kind comment`, and post it as a comment on the tracking issue.

### The rating has no dates

Milestones here have no due dates, and a date never sets importance. The current milestone is the lowest open version, and it is always due now. So the rating says whether work moves and whether the milestone closes in on its end, not whether it is on schedule. The tool checks the rules in this order, and the first one that holds gives the rating:

| Rating | The tool reports it when | Signals that decide |
|---|---|---|
| `done` | Every issue is closed | `closedShare` |
| `not started` | No issue is closed, and no open pull request closes one | `closedShare`, `inReview` |
| `blocked` | An open issue waits on something outside the milestone, or every open issue waits on another | `blockedOutside`, `blocked` |
| `stalled` | No issue closed in 7 days and no pull request is open | `daysSinceLastClose`, `inReview` |
| `growing` | Half the issues or more are closed, and more issues joined in the last 7 days than closed | `closedShare`, `addedLast7Days`, `closedLast7Days` |
| `moving` | None of the above | `daysSinceLastClose`, or `inReview` when no issue is closed |

Milestones run in sequence, so an early milestone can take in new work and stay `moving`. Past half closed the milestone is near release, and new scope that outruns the closes makes it `growing`. An issue counts as added when it joined the milestone after the milestone's first close.

The other signals print with every rating and change no word: `oldestReviewDays`, `oldestBlockerDays`, `addedAfterStart`, `reopened`, and `conditionsClosed` (done-when conditions that name an issue of this repository, by full URL or `#<n>`, and have every named issue closed). `conditionsClosed` is an indirect fact: it never marks a condition met.

Never ask the user for a due date, and never propose one.

## Close or roll over

1. List open issues in the milestone. For each: finish, move to the next milestone, or drop to the backlog. Give a one-line reason. Show the table and wait for a yes.
2. Move issues, then close: `gh api -X PATCH repos/{owner}/{repo}/milestones/<number> -f state=closed`.
3. Post a final status comment on the tracking issue: what shipped against each done-when condition, what moved and why. Close the tracking issue.

Closing a milestone and moving issues change shared state. Never do either without a yes for that exact list.
