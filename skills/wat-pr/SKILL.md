---
name: wat-pr
description: Open or rewrite a GitHub pull request whose description states the design decision, the measured blast radius, how to verify it and what can go wrong, with a change-impact diagram when structure changes. Use when the user asks to open, create, draft, write up, describe or improve a PR, or says "ship this" or "put this up for review".
license: MIT
---

# wat-pr

Policy check first: follow section 1 of the `wat` skill (`../wat/SKILL.md`). Style: `../wat/references/style.md`. Shape: `../wat/references/formats.md`.

## Steps

1. **Check the branch.** `git status`, `git log --oneline <base>..HEAD`. Push the branch if it has no upstream. Never open a PR from the default branch.
2. **Measure.** Facts come before words.
   ```bash
   npx gh-wat-dis impact > .wat-tmp/facts.json
   npx gh-wat-dis blast .wat-tmp/facts.json > .wat-tmp/blast.md
   ```
   Read the facts. Each one carries a provenance label and a source tool. The label sets your wording: see the `wat-architecture` skill.
3. **Read the diff and the linked issue** for what the tools cannot see: the problem this solves, the design decision, the rejected option, the behaviour change. State the problem and the solution in two sentences before you draft. If you cannot state the problem, ask the user. Do not infer it from the diff alone.
4. **Decide on a diagram.** Draw one when the facts show an element or edge with status `added` or `removed`, a changed exported signature with dependents in another element, or a changed contract. Then:
   ```bash
   npx gh-wat-dis graph from-facts .wat-tmp/facts.json > .wat-tmp/change.json
   ```
   Shape the spec with `graph` filters, then edit it: replace generated labels with the real relationship ("publishes OrderPlaced", not "imports (3)") and add technology. Render it with the `wat-diagram` skill. A PR inside one element with no contract change gets no diagram.
5. **Draft** `.wat-tmp/pr.md` in the Pull request format.
   - `Blast radius`: paste `blast.md`, then cut rows a reviewer does not need. Do not add claims the facts do not hold.
   - `Verify`: list the checks you ran with command and result. Then list what the reviewer runs. If you ran nothing, say so.
   - `Risks`: start from the facts. A changed exported signature with dependents → name the callers. A migration or schema → state the deploy order. Risks describe what the change does to the system. They do not grade the code.
   - `Unknowns`: `coChange` lists files that changed with these in the last 90 days and are not in this diff. Check each one, then drop it or list it.
   - `Agent context`: the facts JSON in a `json` block, commands run, follow-ups.
6. **Set the links.** See "Links and auto-close" below. Decide with the user which issues this PR finishes. Write one `Closes #n` line for each, and `Refs #n` for every other issue the PR touches. No issue at all: ask whether to file one, or state "No linked issue" under `Unknowns`.
7. **Read it as the reviewer.** Can a person who has not seen the diff say what the system does differently and where to look first? If not, add what is missing. Then run the backstop: `npx gh-wat-dis lint .wat-tmp/pr.md --kind pr`.
8. **Show the draft.** Wait for a yes unless `policy.confirmBeforeWrite` is `false`.
9. **Post.**
   ```bash
   gh pr create --title "<title>" --body-file .wat-tmp/pr.md --base <base> \
     --attach .wat-tmp/change.svg
   ```
   Add `--draft` when `pulls.draft` is `true` in the config or checks did not run. Set labels and the milestone to match the linked issue: `gh pr edit <n> --add-label <l> --milestone "<title>"`.
10. **Report** the URL. Remove the scratch files.

## Title

Match the repository's convention (check `git log` and recent merged PRs). Default: `<Element>: <what the system now does>`, 70 characters at most, present tense.

## Links and auto-close

A wrong keyword closes an issue that still has work in it. GitHub closes an issue when `close`, `fix` or `resolve` (any tense) sits in front of its number in the PR body **or in any commit message** that reaches the default branch. It ignores the words around the keyword.

1. **Find the candidates.** The issue the branch was made for, issues named in commits, and `npx gh-wat-dis related --title "<pr title>" --body-file .wat-tmp/pr.md` --md for issues nobody linked.
2. **Sort each one.**

   | The PR | Line |
   |---|---|
   | Finishes everything the issue asks for | `Closes #n` |
   | Does part of it, or one of several steps | `Refs #n`, and say what remains under `Follow-ups` or in a comment on the issue |
   | Is a sub-issue's PR under an epic | `Closes #<sub-issue>`, `Refs #<epic>`. Never close the epic from a PR. |
   | Only touches the same area | `Refs #n`, or nothing |

3. **Confirm the close list with the user** when it holds more than one issue, or when you inferred an issue the user did not name.
4. **Check it.** Pass the list the user agreed to:
   ```bash
   npx gh-wat-dis links --body-file .wat-tmp/pr.md --closes <n>,<m> --text   # or: --closes none
   ```
   It reads the body and the branch's commit messages. It exits non-zero when an issue would close that is not in the list, or when a listed issue has no keyword. Fix the body. For a keyword in a commit message, tell the user: the fix is to reword the commit, and that rewrites history, so they decide.
5. **Check again after you post:** `npx gh-wat-dis links --pr <n> --closes <n>,<m> --text`. This compares with what GitHub itself linked, and catches issues linked by hand in the sidebar.

Warnings to act on: a negated keyword ("does not fix #12" still closes #12), a list with one keyword ("Closes #1, #2" closes only #1), a base branch that is not the default (nothing closes until the commits reach the default branch), and a keyword that points at a PR or a closed issue.

## Follow-ups

Use this when the PR can merge and work remains: a cleanup after a release, a second migration step, a case you left out on purpose. The user decides that the PR can merge with work outstanding. Do not decide it for them, and do not create follow-ups to make an unfinished PR look finished.

1. **Name each item** in one line and confirm the list with the user.
2. **File each one** with the `wat-issue` skill, section "Follow-up issues". Run `related` first: the work may already have an issue.
3. **List them** in the PR's `Follow-ups` section: `- #<n> <title>: <why it is not in this PR>`.
4. **Fix the links.** If the original issue is only partly done, change its line from `Closes` to `Refs`, and comment on it with what merged and which follow-up carries the rest. If the original issue is done and the follow-up is new scope, keep `Closes`.
5. **Run `links` again.** The follow-up numbers must show under "Mentioned, stays open".

## Mechanical changes

For a rename, a format pass or a codemod, say "mechanical" in the opening and give the command that reproduces it.

## Update after review

When commits change the design, re-run `npx gh-wat-dis impact`, update `Change`, `Blast radius` and the diagram, and edit the body with `gh pr edit <n> --body-file`. Add one comment that lists what changed since the last review. Do not rewrite history in the description: move settled questions out of `Unknowns`.
