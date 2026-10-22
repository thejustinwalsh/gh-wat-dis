---
name: wat-issue
description: Create or edit a GitHub issue that states the system design impact, the work, the risks and the evidence in a fixed, scannable shape, with an attached diagram unless the work is one a diagram adds nothing to. Use when the user asks to file, write, open, draft, rewrite or improve an issue, bug report, feature request, task, spike or epic.
license: MIT
---

# wat-issue

Policy check first: follow section 1 of the `wat` skill (`../wat/SKILL.md`). Style: `../wat/references/style.md`. Shape: `../wat/references/formats.md`.

## Steps

1. **Scan for related work before you write the body.** Put a working title and the facts a search can match in `.wat-tmp/issue.md`: the error text, the file paths, and the function, flag or command names. Two or three lines are enough. Do not draft sections yet: a duplicate makes them wasted work. Then:
   ```bash
   npx gh-wat-dis related --title "<title>" --body-file .wat-tmp/issue.md --md
   ```
   The table lists open and closed issues and PRs with the signals they share with the draft. If it says **Incomplete** or **Could not search**, GitHub limited the searches: wait a minute and run it again. A failed search is not "no match". The tool reports signals. You judge. Read each candidate at 30 points or more, then sort it with the test in [../wat/references/related.md](../wat/references/related.md). Then report the scan in one line with the test result. Stop and wait for the user only when a candidate is a duplicate, the same symptom with no known cause, or already fixed. With related candidates or no match, continue, and show the scan again with the draft in step 9.
2. **State the problem.** Write it in one or two sentences before anything else. If you cannot, you do not understand the request yet: read more code or ask the user one question. Then state the intended solution, or that it is not known. When the request gives only the problem, propose a solution yourself and do not stop to ask: the user agrees to it or changes it when they read the draft in step 9. Put a choice that is the user's to make in `Unknowns`.
3. **Gather facts.** Read the code the issue names. When the issue names something missing (a page, a command, a test), collect the facts that show the absence: the search you ran and where, and what exists in its place. Skip `reach` and `impact` when no source file is named and no work is in the tree. For a bug, get expected vs actual and a reproduction. When the fault can be seen, a capture of it is strong evidence: a screenshot of the wrong screen, or the wrong output as text. For a visible change with a mock or a reference to hand, a before and after pair is an option: see "Before and after" in the formats. To learn what depends on the code an issue names, run `npx gh-wat-dis reach <path or symbol>`. For work already in the tree, run `npx gh-wat-dis impact --working-tree`. Record what you could not check.
4. **Place it in the system.** Name the elements and relationships from the architecture map in `.agents/gh-wat-dis/config.json`. No map: use the `wat-architecture` skill to name them, and offer to save the map.
5. **Draw the diagram.** Work that changes code gets one. With work in the tree, read `diagram` from the facts of step 3 (`npx gh-wat-dis impact --working-tree > .wat-tmp/facts.json`) and draw at its `level`, or leave it out for its `skip` reason: see "When a diagram is needed" in [../wat-architecture/SKILL.md](../wat-architecture/SKILL.md). With no work in the tree, draw what the work will change: the elements, relationships and parts the issue names, with the status each will have, from `npx gh-wat-dis graph from-config`. Leave it out when the work is one a diagram adds nothing to (the `skip` cases in that section: text, a version bump, CI or config, tests, renames). Use the `wat-diagram` skill. Show the reason for the diagram, or for its absence, in one line with the draft.
6. **Draft** `.wat-tmp/issue.md` in the Issue format. Pick the row in "By issue type" and follow it.
7. **Set fields, not prose.**
   - **Type:** one of `issues.types` (Task, Bug, Feature by default). It is the GitHub issue type when `issues.typeSource` is `issue-type` (organization repositories), and the type label when it is `label` (a repository under a user account has no issue types, so `task`, `bug` or `feature` is a label there). Set exactly one.
   - **Labels:** one or more surface labels from `labels.surfaces` for the parts of the product the work touches. Add the `agents` label only when an agent owns the issue, or the issue holds a prompt an agent runs on a schedule: agent orchestration and maintenance. An issue that is about agents, or that an agent happens to work on, does not get it. No other labels at filing time. When a surface depends on a decision the issue leaves open, label only the surfaces the work touches whichever way the decision goes, and name the possible extra surface beside that decision in `Unknowns`.
   - **Priority:** a label, one of `labels.priorities` (`critical`, `major`, `minor`, `nit`). A person decides it. Set it only when the user gives one. Otherwise leave it for triage, which proposes it.
   - **Relations:** a parent when the issue is part of a larger one, blocked by when it must wait. An issue that goes into a milestone becomes a sub-issue of that milestone's tracking issue (`npx gh-wat-dis milestone` prints it as `tracking`).
   - **Milestone:** when the user has already placed the issue in a milestone or the backlog, use that. Otherwise propose one only when a rule under "Milestone match" in [../wat-triage/SKILL.md](../wat-triage/SKILL.md) holds, and name the rule. Read that section now if the skill is not loaded. Otherwise leave it empty: backlog is a valid answer.
   - **Size:** a label, one of `labels.sizes` (`s`, `m`, `l`, `xl`). Set it only when the user gives one. Otherwise triage proposes it.
8. **Read it as the assignee.** Can a person who was not in this conversation start the work from the body alone? If a term, a reason or a condition is missing, add it. Then run the backstop: `npx gh-wat-dis lint .wat-tmp/issue.md --kind issue`, with `--facts .wat-tmp/facts.json` when you measured work in the tree.
9. **Review the draft.** Check title, fields and body, then publish within the user's authorized scope. Ask only about a decision or authorization still missing, naming the issue action and linking the draft. `policy.confirmBeforeWrite` is a PR-publication preference; it does not add approval to issue creation or edits.
10. **Post.**
   ```bash
   gh issue create --title "<title>" --body-file .wat-tmp/issue.md --type "<Type>" \
     --label "<surface>" --milestone "<milestone>" --attach .wat-tmp/<diagram>.svg
   # user repository: drop --type and add the type label: --label "<type>,<surface>"
   npx gh-wat-dis relate <new> --parent <parent> --blocked-by <blocker>
   ```
   Omit flags you have no value for. Use `relate` for every true relation. Do not write "part of #12" or "blocked by #12" in the body in its place.
11. **Report** the URL and the fields you set. Remove the scratch files.

## Title

`<Element>: <outcome or symptom>`, 70 characters at most. Verb or state, no ticket prefix, no trailing period.

| Not this | This |
|---|---|
| Bug in checkout | Checkout API: duplicate charge when the payment webhook retries |
| Improve performance | Order list: p95 above 2 s for accounts with 10k+ orders |
| Refactor auth | API gateway: validate tokens once at the edge |

## Related, duplicate or new

Sort each candidate with the test in [../wat/references/related.md](../wat/references/related.md).

## Follow-up issues

A follow-up is work that a PR leaves for later on purpose. The `wat-pr` skill calls this section.

1. **The opening** states what remains wrong or unfinished after the PR merges and the work that fixes it. It must make sense to a reader who never saw the PR.
2. **`Evidence`** links the PR: `Follow-up to #<pr>`. Never use a closing keyword here.
3. **`System` and `Change`** carry over only the elements that the remaining work touches.
4. **`Do`** lists the remaining steps. If the work must wait for something (a release, a migration to finish, a metric), say what, and how to check it.
5. **Fields:** the same surface labels as the original issue, and the type that fits the remaining work. Milestone: the current one only if the milestone's done-when conditions need it. Else the next one, or none.
6. **Link it:** add it to the PR's `Follow-ups` section. Give it the same parent as the original issue when that had one (`relate <n> --parent <p>`). If it must wait for something, set blocked by.

## Split or keep

- More than 5 `Do` items: make a parent issue with sub-issues. Each sub-issue gets its own short body.
- Two problems: two issues, linked with a dependency.
- An unknown blocks the design: file a Spike first, and make the feature blocked by it.

## Editing an existing issue

Read the current body and comments first. Keep every fact. Move it into the fixed sections, fold resolved discussion into `Evidence` or `Unknowns`, and say what you changed in one comment. Never delete another person's checked task items.
