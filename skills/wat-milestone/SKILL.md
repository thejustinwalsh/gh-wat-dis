---
name: wat-milestone
description: Create, plan, track and close GitHub milestones. Writes a short milestone description plus a tracking issue with a system diagram, reports progress and risk from live issue data, and proposes scope cuts. Use when the user asks to create or plan a milestone or release, asks "where are we on <milestone>", wants a status update or burndown, or wants to close or roll over a milestone.
license: MIT
---

# wat-milestone

Policy check first: follow section 1 of the `wat` skill (`../wat/SKILL.md`). Commands: `../wat/references/tools.md`. Shapes: `../wat/references/formats.md`.

A milestone has two parts. The **description** is 15 lines of plain Markdown: goal, done-when, scope. The **tracking issue** carries the rich view: diagram, risks, sub-issues, status comments.

## Create

1. **Read the defaults** in `.agents/gh-wat-dis/config.json` → `milestones` (naming, cadence, capacity). List open milestones to avoid a clash.
2. **Get the goal** in one sentence. If the user gives a list of features, ask what a user or the system can do when it ships.
3. **Write done-when conditions.** 3 at most. Each one is observable: a command, a metric, a user action.
4. **Draft** `.wat-tmp/milestone.md` in the Milestone format. Run the backstop: `npx gh-wat-dis lint .wat-tmp/milestone.md --kind milestone`. It catches the elements a milestone description cannot render.
5. **Show the draft**, wait for a yes, then create:
   ```bash
   gh api repos/{owner}/{repo}/milestones -f title="<title>" \
     -f due_on="<YYYY-MM-DD>T00:00:00Z" -F description=@.wat-tmp/milestone.md
   ```
6. **Create the tracking issue** with the `wat-issue` skill, type Epic, in the new milestone. Its `System` section holds a container diagram with status `added` / `changed` for what the milestone delivers. Add member issues as sub-issues. Then put its number in the description's `Tracking` line.

## Plan scope

1. List candidates: open issues with no milestone that match the goal, plus what the user names.
2. For each one, read type, labels, size, dependencies.
3. Fill the milestone to `milestones.capacity` (issues or points, from the config). No capacity set: use the count closed in the last finished milestone.
4. Order by dependency: blockers first. Flag any issue blocked by work outside the milestone.
5. Show one table: `Issue | Why it belongs | Size | Blocked by`. Then a short "Not in" list with the reason. Apply after a yes: `gh issue edit <n> --milestone "<title>"`.

## Report status

1. Pull live data. Do not reuse numbers from memory.
   ```bash
   gh api "repos/{owner}/{repo}/milestones?state=open" --jq '.[] | select(.title=="<title>")'
   gh issue list --milestone "<title>" --state all --limit 200 \
     --json number,title,state,labels,assignees,updatedAt,closedAt
   gh pr list --search 'milestone:"<title>"' --state all --json number,title,state,isDraft,reviewDecision
   ```
2. Compute: closed / total, in review (open PR linked), blocked, not started, days left, issues closed in the last 7 days.
3. Rate it.

   | Rating | Rule |
   |---|---|
   | On track | Remaining ÷ 7-day close rate ≤ weeks left, and nothing blocked on outside work |
   | At risk | Up to 1.5× the time left, or 1 external blocker |
   | Off track | Over 1.5×, or the due date passed |

   No due date or no closes yet: say "No rate yet" and give the counts.
4. Write the Status comment format. Name the 1 to 3 issues that decide the outcome. If at risk or off track, propose the cut: which issues move out and what the milestone still delivers.
5. Show it in chat. Post it as a comment on the tracking issue only when the user asks.

## Close or roll over

1. List open issues in the milestone. For each: finish, move to the next milestone, or drop to the backlog. Give a one-line reason. Show the table and wait for a yes.
2. Move issues, then close: `gh api -X PATCH repos/{owner}/{repo}/milestones/<number> -f state=closed`.
3. Post a final status comment on the tracking issue: what shipped against each done-when condition, what moved and why. Close the tracking issue.

Closing a milestone and moving issues change shared state. Never do either without a yes for that exact list.
