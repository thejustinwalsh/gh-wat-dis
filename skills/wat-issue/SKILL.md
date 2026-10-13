---
name: wat-issue
description: Create or edit a GitHub issue that states the system design impact, the work, the risks and the evidence in a fixed, scannable shape, with an attached diagram when structure changes. Use when the user asks to file, write, open, draft, rewrite or improve an issue, bug report, feature request, task, spike or epic.
license: MIT
---

# wat-issue

Policy check first: follow section 1 of the `wat` skill (`../wat/SKILL.md`). Style: `../wat/references/style.md`. Shape: `../wat/references/formats.md`.

## Steps

1. **Scan for related work.** Write a first title and the facts you have to `.wat-tmp/issue.md`, then:
   ```bash
   npx gh-wat-dis related --title "<title>" --body-file .wat-tmp/issue.md --md
   ```
   The table lists open and closed issues and PRs with the signals they share with the draft. The tool reports signals. You judge. Read each candidate above 30 points, then sort it with "Related, duplicate or new" below. Show the user what you found before you draft further.
2. **State the problem.** Write it in one or two sentences before anything else. If you cannot, you do not understand the request yet: read more code or ask the user one question. Then state the intended solution, or that it is not known.
3. **Gather facts.** Read the code the issue names. For a bug, get expected vs actual and a reproduction. For work that changes code you can see, run `npx gh-wat-dis impact --working-tree --json` or read the files. Record what you could not check.
4. **Place it in the system.** Name the elements and relationships from the architecture map in `.agents/gh-wat-dis/config.json`. No map: use the `wat-architecture` skill to name them, and offer to save the map.
5. **Decide on a diagram.** Draw one when the issue adds, removes or rewires an element or relationship, or when a bug crosses 3 or more elements. Use the `wat-diagram` skill. Otherwise skip it.
6. **Draft** `.wat-tmp/issue.md` in the Issue format. Pick the row in "By issue type" and follow it.
7. **Set fields, not prose.** Choose type, labels, milestone and assignee from the repo config. If the config names no milestone rule, propose one with a one-line reason, or leave it empty.
8. **Read it as the assignee.** Can a person who was not in this conversation start the work from the body alone? If a term, a reason or a condition is missing, add it. Then run the backstop: `npx gh-wat-dis lint .wat-tmp/issue.md --kind issue`.
9. **Show the draft.** Print title, fields and body. Wait for a yes unless `policy.confirmBeforeWrite` is `false`.
10. **Post.**
   ```bash
   gh issue create --title "<title>" --body-file .wat-tmp/issue.md \
     --label "<labels>" --milestone "<milestone>" --attach .wat-tmp/<diagram>.svg
   ```
   Omit flags you have no value for. Then link sub-issues and dependencies (`../wat/references/tools.md`).
11. **Report** the URL and the fields you set. Remove the scratch files.

## Title

`<Element>: <outcome or symptom>`, 70 characters at most. Verb or state, no ticket prefix, no trailing period.

| Not this | This |
|---|---|
| Bug in checkout | Checkout API: duplicate charge when the payment webhook retries |
| Improve performance | Order list: p95 above 2 s for accounts with 10k+ orders |
| Refactor auth | API gateway: validate tokens once at the edge |

## Related, duplicate or new

| Finding | Test | Do |
|---|---|---|
| **Duplicate** | Same root cause in the same element. Fixing one fixes the other. | Do not file. Show the original. Offer a comment there with the new evidence. If it is closed and the problem is back, ask: reopen, or file new with `Refs #n`. |
| **Same symptom, cause not known** | Same error or behaviour, and neither issue names a cause | Ask the user. Default: comment on the existing issue. |
| **Related** | Same element or same feature, a different problem | File new. Add `Refs #n` in `Evidence`. Consider a dependency or a shared parent. |
| **Already fixed** | A merged PR or a closed issue covers it | Tell the user which one and in which release, if known. File only if it still reproduces. |
| **No match** | Nothing above 30 points, or the matches share only common words | File new. |

State the test result in one sentence when you report: "#142 is a duplicate: both fail in `charge.ts` on a webhook retry."

Shared words are weak evidence. The same error text, identifier or file path is strong. Two issues can share every word of a title and have different causes.

## Follow-up issues

A follow-up is work that a PR leaves for later on purpose. The `wat-pr` skill calls this section.

1. **The opening** states what remains wrong or unfinished after the PR merges and the work that fixes it. It must make sense to a reader who never saw the PR.
2. **`Evidence`** links the PR: `Follow-up to #<pr>`. Never use a closing keyword here.
3. **`System` and `Change`** carry over only the elements that the remaining work touches.
4. **`Do`** lists the remaining steps. If the work must wait for something (a release, a migration to finish, a metric), say what, and how to check it.
5. **Fields:** same type labels and element as the original issue. Milestone: the current one only if the milestone's done-when conditions need it. Else the next one, or none.
6. **Link it:** add it to the PR's `Follow-ups` section, and as a sub-issue of the same parent when the original issue had one.

## Split or keep

- More than 5 `Do` items: make an Epic with sub-issues. Each sub-issue gets its own short body.
- Two problems: two issues, linked with a dependency.
- An unknown blocks the design: file a Spike first, and make the feature blocked by it.

## Editing an existing issue

Read the current body and comments first. Keep every fact. Move it into the fixed sections, fold resolved discussion into `Evidence` or `Unknowns`, and say what you changed in one comment. Never delete another person's checked task items.
