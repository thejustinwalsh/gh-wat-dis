---
name: wat-maintain
description: Run GitHub project maintenance. Audits stale issues and PRs, label hygiene, stalled or blocked milestones, issues missing fields, broken links between issues and PRs, and bodies that fail the gh-wat-dis format, then proposes a batch of fixes. Use when the user asks for a cleanup, hygiene pass, backlog audit, maintenance run, stale sweep, or a weekly or monthly project health report.
license: MIT
---

# wat-maintain

Policy check first: follow section 1 of the `wat` skill (`../wat/SKILL.md`). Style: `../wat/references/style.md`. Commands: `../wat/references/tools.md`.

Maintenance has two phases. **Audit** reads and reports. **Apply** changes GitHub, and runs only on the rows the user approves.

## Audit

Run the tool first. It reads GitHub through `gh`, changes nothing, and prints one group for each check with one finding for each item: the item, the measured value and the reason.

```bash
npx gh-wat-dis audit            # JSON: checks[].findings[], leftToAgent[]
npx gh-wat-dis audit --text     # the same as a table
npx gh-wat-dis audit --check stale,labels
```

Run every check unless the user names some. The stale thresholds come from `.agents/gh-wat-dis/config.json`: `triage.staleIssueDays` (60) and `triage.stalePrDays` (14). The tool takes today's date from the clock, so two audits of one repository compare.

| Check | Finds | From |
|---|---|---|
| Stale issues | Open, no update in 60 days | `audit` → `stale-issues` |
| Stale PRs | Open, no update in 14 days | `audit` → `stale-prs` |
| Missing fields | Open issues with no type, no surface, no priority or no size label, or with more than one type, priority or size. A tracking issue needs a type only: its surface, priority and size are those of its sub-issues. | `audit` → `missing-fields` |
| Milestone rating | The current milestone rated `stalled`, `blocked`, `growing` or `not started`. The finding gives the rating, its reason and the signals that decided it. The current milestone is due now, so `not started` is a finding for it. A later milestone rated `not started` is in its normal state and is not a finding. | `audit` → `milestone-status` |
| Finished milestone left open | An open milestone rated `done`: every issue closed | `audit` → `finished-milestone` |
| Orphan PRs | Open PR that closes no issue | `audit` → `orphan-prs` |
| Done but open | Issue whose linked PR merged. Also an open issue in the current milestone that a merged PR names with `Refs`: read each PR the finding names and say whether it finished the work. | `audit` → `done-but-open`, then read the PRs |
| Label hygiene | Labels the config wants and GitHub lacks, labels that drifted, and labels outside the plan with the number of open issues on each (status is not a label; type is a label only on a user repository) | `audit` → `labels` |
| Blocked chains | Issues blocked by a closed or stale issue | `audit` → `blocked-chains` |
| Milestone description | An open milestone whose description has no `**Tracking:**` line, or a current milestone with no tracking issue. | `audit` → `milestone-description` |

The tool counts. These checks need reading, and the output names them in `leftToAgent`. Do them yourself, on the open issues of the current milestone:

| Check | Finds | How |
|---|---|---|
| Awaiting author | The last comment is a question from a maintainer, with no reply in 14 days | `npx gh-wat-dis issues` → rows with `comments` above 0 and `updatedAt` older than 14 days; read the last comment of each |
| Format drift | No clear problem statement, no system statement, a body GitHub renders wrong, or a `Refs #n` line that repeats a parent or blocked-by relation the issue already has. A Task meets the system statement by naming its element in the opening: it needs no `System` section. | read each body against `../wat/references/formats.md`; relations from `npx gh-wat-dis relations <n>` |
| Out-of-date facts | A statement that another issue, a merged PR or the code now contradicts | read while you check format drift; name the source that contradicts it |
| Done-when conditions | A condition of an open milestone that can no longer be checked, because the thing it names was removed or renamed. A condition that is now met is progress to report, and it stays in the description. | `npx gh-wat-dis milestone "<title>"` → `doneWhen`; check each condition against the repository |

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
