# Other lenses

C4 names the boxes and lines. These lenses supply questions that make an issue or PR complete. Use one when the change calls for it. Each adds a sentence or a row, not a new section.

| Lens | Ask | Lands in |
|---|---|---|
| **Decision records** (ADR: context, decision, consequences) | Does this change make, apply or reverse a decision? Which option lost, and why? | `System`: one sentence. Link the ADR if the repo keeps them. |
| **Runtime vs structure** (4+1 views) | Does the code structure change, the runtime behaviour, or where it runs? | Picks the diagram: component, dynamic or deployment |
| **Bounded contexts** (domain-driven design) | Does a model or term cross from one context into another? Is there a translation layer? | `Change` row for the boundary; `Risks` if a model leaks |
| **Data flow and trust boundaries** (threat modelling) | Does data cross a trust boundary, reach a new store, or leave to a new external system? | `Risks`. Name the data and the boundary. |
| **Sequence** | Does the order of calls change? Is a step now async, retried, or able to fail part-way? | Dynamic diagram or a numbered list |
| **Dependency reach** | Who imports what changed, directly and through others? | `Blast radius`, from `npx gh-wat-dis impact` |
| **Contracts** | Which API, schema, event or config shape do separate deploys share? | The alert, `Risks`, deploy order in `Verify` |
| **Ownership** (CODEOWNERS, team boundaries) | Which teams own the touched and reached paths? | Reviewers; `Blast radius` owners column |
| **Quality scenarios** (arc42) | Which quality does this trade: latency, availability, cost, operability? What is the measured before and after? | `Evidence` with numbers, or `Unknowns` with the check |

## How to state a design decision

Three parts, one sentence each:

1. **Decision.** "The API gateway validates tokens."
2. **Reason.** "Four services held four copies of the check, and two disagreed on expiry."
3. **Cost.** "The gateway is now on the path of every request."

Name the rejected option only when a reviewer would ask for it.

## How to state a risk

`<What breaks>, <when>` → `<what the change does about it, or how to detect it>`.

- **Old workers read the new column as null** during a rolling deploy → the migration ships one release before the reader.
- **Webhook retries create a second charge** when the first response takes over 10 s → the handler keys on `event.id`.

A risk with no mitigation and no detection is an `Unknown`. Move it there and name the check.
