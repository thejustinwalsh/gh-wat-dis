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
| Set the type, organization repository | `gh issue create --type Bug`, `gh issue edit <n> --type Feature` |
| Set the type, user repository | `gh issue create --label bug`, `gh issue edit <n> --add-label feature --remove-label task` |
| Make an issue a sub-issue | `npx gh-wat-dis relate <n> --parent <parent>` |
| Record what blocks an issue | `npx gh-wat-dis relate <n> --blocked-by <a>,<b>` · `--blocks <c>` · add `--remove` to undo |
| Create the labels the config wants (type labels on a user repository, `agents`, surfaces) | `npx gh-wat-dis labels apply` |
| Pin issue | `gh issue pin <n>` |

`relate` looks up the ids that GitHub's relation calls need. You pass issue numbers. An issue has one parent: `--parent` on an issue that has another parent replaces it, and the output states the old and the new one.

## Milestones (REST through `gh api`)

`gh` has no milestone command. The MCP server has no milestone tools.

| Action | Command |
|---|---|
| List | `gh api "repos/{owner}/{repo}/milestones?state=open" --jq '.[] \| {number,title,description}'` |
| Rating and status numbers | `npx gh-wat-dis milestone ["<title>"]` |
| Create | `gh api repos/{owner}/{repo}/milestones -f title="<t>" -F description=@desc.md` (no due date) |
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

The server's own instructions say to call `search_issues` before you create an issue. `npx gh-wat-dis related` does that job here, with better signals: use it instead. Call `list_issue_types` before you set a type in an organization repository, and pass `fields` projections on list calls to keep output small.

No MCP server connected? Use `gh issue list|view`, `gh pr list|view|diff|checks`, `gh search issues`, each with `--json`.

## Measure (gh-wat-dis CLI)

| Need | Command |
|---|---|
| Facts on what a change touches and reaches | `npx gh-wat-dis impact > facts.json` |
| The same, with uncommitted work | `npx gh-wat-dis impact --working-tree > facts.json` |
| The same, between any two commits (a merged PR) | `npx gh-wat-dis impact --base <ref> --head <ref> > facts.json` |
| Blast radius section for a PR body: what the change reaches outside its diff, with file links | `npx gh-wat-dis blast facts.json` |
| Who depends on a file or symbol (no diff needed) | `npx gh-wat-dis reach src/price.ts#formatPrice` |
| Owners of paths | `npx gh-wat-dis owners <path>...` |
| Architecture elements and the files they map | `npx gh-wat-dis elements` |
| Diagram spec from facts | `npx gh-wat-dis graph from-facts facts.json > change.json` |
| Diagram spec from the architecture map | `npx gh-wat-dis graph from-config > system.json` |
| Reshape a spec | `npx gh-wat-dis graph focus\|collapse\|drop\|merge\|diff\|set\|rename` |
| Inspect a spec | `npx gh-wat-dis graph stats change.json` · `graph ids change.json` |
| Overview plus one spec per changed group | `npx gh-wat-dis graph split change.json --out-dir views` |
| Render a diagram, fitted to GitHub's width | `npx gh-wat-dis diagram change.json -o change.svg` |
| The same, plus a PNG to look at | `npx gh-wat-dis diagram change.json -o change.svg --png change.png` |
| Legend table for a diagram with numbered lines | `npx gh-wat-dis legend change.json` |
| Open issues with type, surfaces, milestone and what is missing | `npx gh-wat-dis issues` · `--queue` for those that need triage |
| What a repository with history holds: counts of what open issues lack, labels outside the plan, milestones | `npx gh-wat-dis survey` · `--issues` for one row per issue |
| Maintenance findings: stale issues and PRs, missing fields, milestones, orphan PRs, done but open, labels, blocked chains | `npx gh-wat-dis audit` · `--text` for a table · `--check stale,labels` for some checks |
| Related issues and PRs for a draft | `npx gh-wat-dis related --title "<title>" --body-file body.md --md` |
| Related issues for an existing issue | `npx gh-wat-dis related --issue <n> --kind issue --md` |
| A milestone's rating with the signals behind it, and the status numbers: counts, in review, blocked, done-when | `npx gh-wat-dis milestone ["<title>"]` |
| An issue's parent, sub-issues, blocked by, blocking | `npx gh-wat-dis relations <n>` |
| Labels the config wants, compared with GitHub | `npx gh-wat-dis labels --text` |
| What a PR will close on merge | `npx gh-wat-dis links --body-file pr.md --closes <n>,<m> --text` |
| The same, for an open PR | `npx gh-wat-dis links --pr <n> --closes <n>,<m> --text` |
| Backstop check of a body | `npx gh-wat-dis lint body.md --kind issue\|pr\|milestone\|comment` |
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

`npx gh-wat-dis help` lists every tool with what it does and whether it writes; `npx gh-wat-dis help --json` prints the same list as JSON, and `npx gh-wat-dis <tool> --help` gives one tool's options. When a skill and the help disagree, the help is right.

Every command runs through `npx`. A project adds `gh-wat-dis` as a dev dependency, so `npx` runs the project's own copy with no download. In a project with no `package.json`, `npx` downloads the package on the first run and uses the npm cache after that.

## Scratch files

`.wat-tmp/` at the repo root holds drafts, specs and images, and `npx gh-wat-dis init` git-ignores it. Give each task a folder of its own there, named for the task: `.wat-tmp/issue-webhook-retry/`, `.wat-tmp/pr-123/`. Write every file of the task in that folder, and read `.wat-tmp/` in a skill's commands as that folder. Other sessions and unposted work keep their own folders this way, and one `rm -r` of your folder cleans up after the post succeeds.
