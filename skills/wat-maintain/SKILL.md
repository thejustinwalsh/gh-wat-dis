---
name: wat-maintain
description: Run GitHub project maintenance. Audits stale issues and PRs, label hygiene, stalled or blocked milestones, issues missing fields, broken links between issues and PRs, and bodies that fail the gh-wat-dis format, then proposes a batch of fixes. Use when the user asks for a cleanup, hygiene pass, backlog audit, maintenance run, stale sweep, or a weekly or monthly project health report.
license: MIT
---

# wat-maintain

Policy check first: follow section 1 of the `wat` skill (`../wat/SKILL.md`). Style: `../wat/references/style.md`. Commands: `../wat/references/tools.md`.

Maintenance has two phases. **Audit** reads and reports. **Apply** changes GitHub, and runs only on the rows the user approves.

## Audit

Run the checks the user asks for. Default: all. Two thresholds come from `.agents/gh-wat-dis/config.json`: `triage.staleIssueDays` (60) and `triage.stalePrDays` (14). The others are fixed and stated in the table.

Run the queries in the table with `gh`, as written. They filter by `updated:<DATE`, `linked:pr` and `is:blocked` and read milestones and closing references, and the GitHub MCP server has no tool for those.

List the open milestones first (`gh api "repos/{owner}/{repo}/milestones?state=open" --jq '.[].title'`): the milestone checks run once for each title.

| Check | Finds | Query |
|---|---|---|
| Stale issues | Open, no update in 60 days | `gh issue list --search "updated:<DATE sort:updated-asc" --json number,title,updatedAt,labels,milestone` |
| Stale PRs | Open, no update in 14 days | `gh pr list --search "updated:<DATE" --json number,title,updatedAt,isDraft,reviewDecision,author` |
| Awaiting author | The last comment is a question from a maintainer, with no reply in 14 days | `gh issue list --search "updated:<DATE comments:>0"`, then read the last comment |
| Missing fields | Open issues with no type, no surface, no priority or no size label, or with more than one type, priority or size. A tracking issue needs a type only: its surface, priority and size are those of its sub-issues, and the tool leaves them out of `missing`. | `npx gh-wat-dis issues` → rows where `missing` is not empty |
| Stalled or blocked milestone | The current milestone with no issue closed in 7 days, or with an issue blocked from outside. A later milestone that reports `stalled` has not started: its status is not a finding. Its description is still checked in the Milestone description row. | `npx gh-wat-dis milestone` → `status` |
| Finished milestone left open | Every issue closed | `npx gh-wat-dis milestone "<title>"` → `status: done` |
| Orphan PRs | Open PR that closes no issue | `gh pr list --json number,title,closingIssuesReferences` |
| Done but open | Issue whose linked PR merged. Also an open issue in the current milestone that a merged PR names with `Refs`: read the PR and say whether it finished the work. | `gh issue list --search "linked:pr is:open"` then check PR state. For the second: `gh pr list --state merged --search '"Refs #<n>" in:body' --json number,title`, and keep only the PRs whose body holds that exact reference |
| Label hygiene | Labels the config wants and GitHub lacks, labels that drifted, and labels outside the plan (status is not a label; type is a label only on a user repository) | `npx gh-wat-dis labels --text` |
| Blocked chains | Issues blocked by a closed or stale issue | `npx gh-wat-dis relations <n>` for each issue from `gh issue list --search "is:blocked"` |
| Format drift | Open issues in the current milestone with no clear problem statement, no system statement, a body GitHub renders wrong, or a `Refs #n` line that repeats a parent or blocked-by relation the issue already has. A Task meets the system statement by naming its element in the opening: it needs no `System` section. | read each body against `../wat/references/formats.md`; relations from `npx gh-wat-dis relations <n>` |
| Out-of-date facts | A statement in an open issue of the current milestone that another issue, a merged PR or the code now contradicts | read while you check format drift; name the source that contradicts it |
| Milestone description | An open milestone whose description has no `**Tracking:**` line, a current milestone with no tracking issue, or a done-when condition that can no longer be checked, because the thing it names was removed or renamed. A condition that is now met is progress to report, and it stays in the description. | `npx gh-wat-dis milestone "<title>"` → `trackingFrom`, `tracking`, `doneWhen`; check each condition against the repository |

Compute dates in the shell (`date -v-60d +%Y-%m-%d` on macOS, `date -d '60 days ago' +%Y-%m-%d` on Linux). Do not guess today's date.

## Report

```markdown
**<Repo> health**: <n> findings, <m> need a decision.

| Check | Count | Worst case |
|---|---|---|
| Stale issues | 12 | #88, 214 days |
| Stalled milestone | 1 | v1.3, 9 days with no close |

**Proposed fixes**
| # | Item | Action | Reason |
|---|---|---|---|
| 1 | #88 | Close as not planned | 214 days idle, element removed in #140 |
| 2 | v1.3 | Move 2 open issues to v1.4, close | Stalled, 14 of 16 closed |
| 3 | label `bug ` / `Bug` | Merge into `type: bug` | Same meaning |
```

- **Needs a decision** counts the findings where the action itself is open: more than one reasonable fix, or a choice only the user can make. Every fix needs a yes before it is applied, so a yes alone does not count.
- **A finding that fits no check** still goes in the report. Add a row named "Outside the checks" and say what you looked at.

List 5 fixes per check at most, worst first. Give the full list in an Agent context block only if the user wants the report posted as an issue.

## Apply

1. Ask which rows to apply. Accept row numbers.
2. Apply one row at a time. Leave a one-sentence comment on each issue you close or move: the reason and what reopens it.
3. Report what changed, with links, and what failed.

## Never without an explicit yes for that item

- Close an issue or PR
- Delete or rename a label (`labels apply --prune` removes it from every issue, and that cannot be undone)
- Close a milestone or move issues between milestones
- Edit another person's issue body

## Never at all

- Delete issues, comments or branches
- Lock conversations
- Close an issue only because it is old: check that the element still exists and the problem still reproduces, or say you could not check

## Recurring runs

For a weekly report, tell the user to schedule their agent to run "wat-maintain, audit only, post nothing". The audit is read-only and safe to automate. Apply stays manual.
