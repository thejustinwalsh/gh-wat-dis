# Tools

Write with `gh`. Read with the GitHub MCP server. Measure with `npx gh-wat-dis`.

Always write the body to a file and pass `--body-file`. Never pass a body inline: quoting breaks Markdown.

## Write (GitHub CLI)

| Action | Command |
|---|---|
| Create issue | `gh issue create --title "<t>" --body-file body.md --label "<a>,<b>" --milestone "<title>" --assignee @me --attach ./d.svg` |
| Edit issue | `gh issue edit <n> --body-file body.md --add-label <l> --milestone "<title>" --attach ./d.svg` |
| Comment | `gh issue comment <n> --body-file c.md` · `gh pr comment <n> --body-file c.md` |
| Close issue | `gh issue close <n> --reason completed` · `--reason "not planned"` · `--duplicate-of <m>` |
| Create PR | `gh pr create --title "<t>" --body-file body.md --base <branch> --draft --attach ./d.svg` |
| Edit PR | `gh pr edit <n> --body-file body.md --add-label <l> --milestone "<title>"` |
| Create label | `gh label create "<name>" --color <hex> --description "<d>"` |
| Add sub-issue | `gh api repos/{owner}/{repo}/issues/<parent>/sub_issues -F sub_issue_id=<child id>` |
| Add dependency | `gh api repos/{owner}/{repo}/issues/<n>/dependencies/blocked_by -F issue_id=<blocker id>` |
| Pin issue | `gh issue pin <n>` |

Sub-issue and dependency calls take the issue **id**, not the number: `gh issue view <n> --json id --jq .id` gives a node id; for the REST id use `gh api repos/{owner}/{repo}/issues/<n> --jq .id`.

## Milestones (REST through `gh api`)

`gh` has no milestone command. The MCP server has no milestone tools.

| Action | Command |
|---|---|
| List | `gh api "repos/{owner}/{repo}/milestones?state=open&sort=due_on" --jq '.[] \| {number,title,due_on,open_issues,closed_issues}'` |
| Create | `gh api repos/{owner}/{repo}/milestones -f title="<t>" -f due_on="<YYYY-MM-DD>T00:00:00Z" -F description=@desc.md` |
| Edit | `gh api -X PATCH repos/{owner}/{repo}/milestones/<number> -F description=@desc.md` |
| Close | `gh api -X PATCH repos/{owner}/{repo}/milestones/<number> -f state=closed` |
| Issues in it | `gh issue list --milestone "<title>" --state all --json number,title,state,labels,assignees` |

`{owner}` and `{repo}` are literal: `gh api` fills them from the current repository.

## Read (GitHub MCP server)

| Need | Tool |
|---|---|
| Who am I | `get_me` |
| One issue, its comments, sub-issues, parent | `issue_read` (`get`, `get_comments`, `get_sub_issues`, `get_parent`) |
| List or search issues | `list_issues`, `search_issues` |
| Issue types and fields in an org | `list_issue_types`, `list_issue_fields` |
| One PR: diff, files, checks, reviews | `pull_request_read` (`get_diff`, `get_files`, `get_check_runs`, `get_reviews`, `get_review_comments`) |
| List or search PRs | `list_pull_requests`, `search_pull_requests` |
| File at a ref | `get_file_contents` |
| Labels | `list_label` (needs the `labels` toolset) |
| Projects | `projects_list`, `projects_get` (needs the `projects` toolset) |

Rules from the server's own instructions: call `search_issues` before you create an issue; call `list_issue_types` before you set a type; pass `fields` projections on list calls to keep output small.

No MCP server connected? Use `gh issue list|view`, `gh pr list|view|diff|checks`, `gh search issues`, each with `--json`.

## Measure (gh-wat-dis CLI)

| Need | Command |
|---|---|
| Facts on what a change touches and reaches | `npx gh-wat-dis impact > facts.json` |
| The same, with uncommitted work | `npx gh-wat-dis impact --working-tree > facts.json` |
| Blast radius section for a PR body | `npx gh-wat-dis blast facts.json` |
| Who depends on a file or symbol (no diff needed) | `npx gh-wat-dis reach src/price.ts#formatPrice` |
| Owners of paths | `npx gh-wat-dis owners <path>...` |
| Architecture elements and the files they map | `npx gh-wat-dis elements` |
| Diagram spec from facts | `npx gh-wat-dis graph from-facts facts.json > change.json` |
| Diagram spec from the architecture map | `npx gh-wat-dis graph from-config > system.json` |
| Reshape a spec | `npx gh-wat-dis graph focus\|collapse\|drop\|merge\|diff\|set\|rename` |
| Inspect a spec | `npx gh-wat-dis graph stats change.json` · `graph ids change.json` |
| Overview plus one spec per changed group | `npx gh-wat-dis graph split change.json --out-dir views` |
| Render a diagram, fitted to GitHub's width | `npx gh-wat-dis diagram change.json -o change.svg` |
| Legend table for a diagram with numbered lines | `npx gh-wat-dis legend change.json` |
| Related issues and PRs for a draft | `npx gh-wat-dis related --title "<title>" --body-file body.md --md` |
| Related issues for an existing issue | `npx gh-wat-dis related --issue <n> --md` |
| What a PR will close on merge | `npx gh-wat-dis links --body-file pr.md --closes <n>,<m> --text` |
| The same, for an open PR | `npx gh-wat-dis links --pr <n> --closes <n>,<m> --text` |
| Backstop check of a body | `npx gh-wat-dis lint body.md --kind issue\|pr\|milestone` |
| Health check | `npx gh-wat-dis doctor` |

### Compose them

Each tool does one thing. Data tools print JSON on stdout. `-` or piped stdin stands in for a file. Chain them, and add a filter where the default shape is wrong:

```bash
npx gh-wat-dis impact \
  | npx gh-wat-dis graph from-facts \
  | npx gh-wat-dis graph focus --on status:changed,added,removed --hops 1 \
  | npx gh-wat-dis graph collapse --to-type container \
  | npx gh-wat-dis diagram -o .wat-tmp/change.svg
```

A diagram spec is plain JSON. When no filter does what you need, edit the file. Run any tool with `--help` for its options.

Every command runs through `npx`. A project installs nothing. The first run downloads the package; later runs use the npm cache.

## Scratch files

Write drafts, specs and SVGs to `.wat-tmp/` at the repo root (git-ignored by `npx gh-wat-dis init`). Remove them after the post succeeds.
