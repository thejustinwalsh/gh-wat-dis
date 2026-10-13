# Related, duplicate or new

`npx gh-wat-dis related` lists issues and pull requests that share something with a draft or an issue. It reports signals. You decide what each candidate is.

## Points

Points run from 0 to 100 and add up what a candidate shares:

| Shared | Points | Label |
|---|---|---|
| The same error text | 40 | `exact` |
| An identifier (a function, a field, a command) | 20 each, 40 at most | `exact` |
| A file path | 20 each, 40 at most | `exact` |
| Words in the title | up to 30 | `heuristic` |
| Words in the body | 10 | `heuristic` |

30 or more means at least one exact match, or a title that is almost the same. Read every candidate at 30 or more. Below 30 the candidate shares only common words: skip it unless the title looks like the same problem.

## Issues and pull requests

- To look for a **duplicate**, search issues only: `--kind issue`. A pull request cannot be a duplicate of an issue.
- A **pull request** in the list answers a different question: was this already fixed, or is someone fixing it now? A merged one that covers the problem makes the issue "already fixed". An open one is where the work is.

## The test

| Finding | Test | Do |
|---|---|---|
| **Duplicate** | Same root cause in the same element. Fixing one fixes the other. | Do not file. Show the original. Offer a comment there with the new evidence. If it is closed and the problem is back, ask: reopen, or file new with a `Refs #n` line. |
| **Same symptom, cause not known** | Same error or behaviour, and neither issue names a cause | Ask the user. Default: comment on the existing issue. |
| **Related** | Same element or same feature, a different problem | File new. If one must wait for the other, set blocked by. If both are parts of one piece of work, give them the same parent. Otherwise add a `Refs #n` line at the end of the body. |
| **Already fixed** | A merged PR or a closed issue covers it | Tell the user which one and in which release, if known. File only if it still reproduces. |
| **No match** | Nothing above 30 points, or the matches share only common words | File new. |

State the test result in one sentence when you report: "#142 is a duplicate: both fail in `charge.ts` on a webhook retry."

Shared words are weak evidence. The same error text, identifier or file path is strong. Two issues can share every word of a title and have different causes.
