---
name: wat-maintain
description: Run GitHub project maintenance. Audits stale issues and PRs, label hygiene, stalled or blocked milestones, issues missing fields, broken links between issues and PRs, and bodies that fail the gh-wat-dis format, then proposes a batch of fixes. Use when the user asks for a cleanup, hygiene pass, backlog audit, maintenance run, stale sweep, or a weekly or monthly project health report.
license: MIT
---

# wat-maintain

Policy check first: follow section 1 of the `wat` skill (`../wat/SKILL.md`). Commands: `../wat/references/tools.md`.

Maintenance has two phases. **Audit** reads and reports. **Apply** changes GitHub, and runs only on the rows the user approves.

## Audit

Run the checks the user asks for. Default: all. Thresholds come from `.agents/gh-wat-dis/config.json` → `triage` and `maintain`; the defaults are below.

| Check | Finds | Query |
|---|---|---|
| Stale issues | Open, no update in 60 days | `gh issue list --search "updated:<DATE sort:updated-asc" --json number,title,updatedAt,labels,milestone` |
| Stale PRs | Open, no update in 14 days | `gh pr list --search "updated:<DATE" --json number,title,updatedAt,isDraft,reviewDecision,author` |
| Awaiting author | The last comment is a question from a maintainer, with no reply in 14 days | `gh issue list --search "updated:<DATE comments:>0"`, then read the last comment |
| Missing fields | Open issues with no type (issue type, or type label on a user repository), more than one type label, or no surface label | `gh issue list --search "no:label"`, and `--json number,title,labels` checked against `labels.surfaces` |
| Stalled or blocked milestone | The current milestone with no issue closed in 7 days, or with an issue blocked from outside | `npx gh-wat-dis milestone` → `status` |
| Finished milestone left open | Every issue closed | `npx gh-wat-dis milestone "<title>"` → `status: done` |
| Orphan PRs | Open PR that closes no issue | `gh pr list --json number,title,closingIssuesReferences` |
| Done but open | Issue whose linked PR merged | `gh issue list --search "linked:pr is:open"` then check PR state |
| Label hygiene | Labels the config wants and GitHub lacks, labels that drifted, and labels outside the plan (priority and status are not labels; type is a label only on a user repository) | `npx gh-wat-dis labels --text` |
| Blocked chains | Issues blocked by a closed or stale issue | `npx gh-wat-dis relations <n>` for each issue from `gh issue list --search "is:blocked"` |
| Format drift | Open issues in the current milestone with no clear problem statement, no system statement, or a body GitHub renders wrong | read each body against `../wat/references/formats.md` |

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
