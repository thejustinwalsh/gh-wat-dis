# Style

The reader is an engineer with ten open tabs and two minutes. These rules have two layers. **Shape** sets what you say and in what order. **Language** sets how each sentence reads.

Adapted from [attention-control](https://github.com/aaddrick/attention-control) and [no-ai-slop](https://github.com/petergyang/no-ai-slop) (both MIT). See `NOTICE.md` in the package.

## Scope

| Text | Rule |
|---|---|
| Prose you write | Apply every rule below. |
| Code, commands, paths, identifiers, error messages | Copy verbatim. |
| Quoted text | Copy verbatim. |
| Commit messages, code comments | Match the repository. |

Accuracy wins over style. Never drop a fact, condition, number or scope qualifier to make a sentence shorter.

## Substance before structure

Structure helps only when it holds something. A heading over one vague line, a table with one row, a checklist of obvious steps: each adds reading cost and no information. Write the sentence instead. Use a section, table or list when the content has that shape, and leave it out when it does not.

## Clear beats short

The goal is low effort for the reader, not a low word count. Compression that forces the reader to guess costs more than the words it saved.

- Keep the **reason** for a decision. "The gateway validates tokens" tells a reviewer nothing without "because two services disagreed on expiry".
- Keep **conditions and scope**: "for accounts with 10k+ orders", "only during a rolling deploy".
- Keep the **link between steps** when order or cause matters.
- Define a term the reader may not know. One clause is enough.
- If a new team member could not act on the body, it is too short. Add the missing sentence.

Every number below is a default for ordinary cases. Break it when the content needs room, and never break a sentence to meet it.

## Shape

1. **Open with the problem and the solution.** The first sentence or two of every issue and PR say what the problem is and how we solve it, in plain prose with no label or heading. The problem must be clear to a reader with no context. If the solution is not known, say so and make the problem as clear as you can, as early as you can.
2. **System before detail.** The second thing the reader sees is the design: the diagram or the `System` section.
3. **One action per step.** Number steps that have an order. Each step is one bounded action a person can start now.
4. **Name runnable actions.** "Run the backfill" is a label. `pnpm db:backfill --since 2026-01-01` is an action.
5. **Keep lists short.** Past about 5 items a list stops being scanned. Group it (must / later, now / next) or move reference detail into the agent block. Do not drop an item that someone must act on.
6. **One alert, as a rule.** Use `> [!WARNING]` or `> [!IMPORTANT]` for the thing that blocks or breaks. Each extra alert weakens the others.
7. **State problems flat.** Location, cause, fix. `auth.spec.ts:42` fails: expected 200, got 401. Cause: the token expires in the fixture. Fix: freeze the clock.
8. **Use concrete units.** "2 services, 14 importers, 1 migration" beats "several areas". Give sizes as S (under 1 day), M (1 to 3 days), L (over 3 days) only when the repo config asks for estimates.
9. **Put state in GitHub fields.** Issue type, surface labels, milestone, assignee, parent and blocked-by relations go in the fields. Do not repeat them in prose.
10. **No preamble, no recap, no closer.** Delete the sentence that announces the body and the sentence that sums it up.
11. **One topic per artifact.** A second problem gets a second issue. Link it.

## Language

**Words**
- One word, one meaning. Pick a term for each element and keep it. Do not rotate synonyms ("service", "API", "backend" for the same thing).
- One action, one verb. Preferred verbs: check, make sure, start, stop, use, show, find, change, remove, need. Use "delete" only for the literal operation.
- Element names match the architecture map in `.agents/gh-wat-dis/config.json` and the diagram, letter for letter.
- Define an acronym once, or do not use it.

**Grammar**
- Active voice. Name the actor: "The worker retries the job", not "The job is retried".
- Simple tenses. "The cache stores" / "The cache stored". No "has been storing".
- Imperative for instructions: "Add the index."

**Sentences**
- Aim for 20 words in an instruction and 25 in a description. A longer sentence that holds one complete thought is better than two fragments.
- One instruction per sentence.
- Keep subjects, verbs and articles. Telegraph style costs the reader more than it saves.
- Noun clusters: about 3 words. "The mechanism that refreshes the auth token", not "auth token refresh mechanism failure".
- Warnings start with the command or the condition: "Before you deploy, pause the queue."

**Structure**
- A paragraph covers one topic, usually in 3 sentences or fewer. If the content is a comparison or a sequence, use a table or a list. If it is reasoning, keep it as prose.
- Table for a comparison (before / after, option A / B, element / change). Numbered list for a sequence. Bullets for 3 or more parallel items.

## Collisions

| Collision | Winner |
|---|---|
| Short vs complete | Cut whole sentences. Never cut words inside a sentence you keep. |
| Confident vs uncertain | Delete hedging adverbs. Keep real uncertainty, and name the check that settles it. |
| Rule vs fact | The fact. If a rule fights a correct answer, break the rule. |
| Style vs repo config | The repo config. |

## Specific beats general

A sentence that could sit unchanged in another project's issue says nothing about this one.

- **Portability test.** Read each sentence and ask whether it would still be true of any other repository. If yes, cut it or replace it with a fact about this change: a name, a number, a date, a mechanism, a consequence.
- **Protect the specific fact.** Do not smooth a detail into general importance. "This improves reliability" hides what "retries stop charging the card twice" tells.
- **Show, then stop.** Let the fact carry the weight. Do not add a line that tells the reader the point is important, subtle, surprising or key. If the fact does not show it, the line will not either.
- **Verbs do the work.** "Decided", not "made a decision". "Can", not "has the ability to". Prefer "is" and "has" to a verb that only sounds strong: "the queue holds failed charges", not "the queue serves as a hub for failed charges".
- **People and programs act. Abstractions do not.** "The worker retries the charge", not "the retry logic emerged".
- **Name the source or cut the claim.** "Studies show", "it is widely agreed" and "many users report" are not evidence. Link the report, give the count, or move it to `Unknowns`.

## Patterns to cut

These are the habits that make text read as machine-written. Each one spends the reader's attention and tells them nothing.

| Pattern | Looks like | Write |
|---|---|---|
| Contrast setup | "This is not a refactor. It is a redesign." "It is not only X but Y." | State Y: "This redesigns the retry path." |
| Negative list | "Not a cache. Not a queue. A ledger." | "It is a ledger." |
| Throat-clearing | "Here is the thing", "Let me be clear", "To be honest" | The point |
| Lone-expert setup | "What most people miss", "The part nobody mentions" | The claim, with its evidence |
| Colon reveal | "The detail that makes it work: a second worker." | "A second worker makes it work." Keep colons for lists, labels and quotes. |
| Trailing "-ing" analysis | "…adds an index, highlighting our focus on speed" | The effect: "…adds an index, so the list loads in 200 ms." |
| Importance puffery | "marks a pivotal step", "plays a vital role", "is a testament to" | The fact. The reader judges its weight. |
| Commentary on the text | "The key point is", "As you can see", "This distinction matters", "In other words" | Delete it. If the point is unclear, add the missing fact. |
| Synonym rotation | "the worker… the service… the job" for one thing | One name, repeated |
| Stacked fragments | "It works. Every time. No exceptions." | One complete sentence |
| Question-and-answer | "The result? A 40% drop." "What if retries were free?" | "Retries dropped 40%." |
| Mic-drop ending | A last line that turns the point into a slogan or a metaphor | Delete it. End on the last concrete fact or the next action. |
| Recap ending | "In conclusion", "Overall", a closing paragraph that restates the body | Delete it |
| Uniform rhythm | Every sentence the same length, every paragraph the same shape | Let the content set the shape |
| Decoration | Emoji in headings, bold scattered in sentences, a heading over two sentences, bullets where two sentences would read better | Plain prose |
| Dash as a habit | Em dashes joining clauses | A comma, a period or parentheses. None in short text. |

## Words to delete

Preamble and filler: "This PR", "This issue", "I've gone ahead and", "As discussed", "In order to", "It should be noted", "It is worth noting", "Please note", "When it comes to", "At its core", "In terms of", "With regard to", "Going forward", "At the end of the day", "The reality is".

Empty adverbs: "basically", "simply", "just", "obviously", "of course", "actually", "truly", "literally", "honestly", "fundamentally", "importantly", "crucially", "inherently". Keep one only when it carries a real contrast or a real doubt.

Empty hedges: "might potentially", "should hopefully", "seems to maybe".

Inflated words: "leverage", "utilize", "facilitate", "streamline", "empower", "harness", "elevate", "foster", "delve", "supercharge", "robust", "seamless", "cutting-edge", "transformative", "meticulous", "intricate", "multifaceted", "paramount", "game changer", "paradigm shift".

## Check before you post

1. Read the opening alone. Does it say what the problem is and how it is, or will be, solved? If the solution is not known, is the problem unmistakable?
2. Read the section headings alone. Do they match [formats.md](formats.md)?
3. Does every claim about the code trace to a fact you measured or read?
4. Does one word mean one thing through the whole body?
5. Could a new team member act on it without asking you a question?
6. Does any sentence pass the portability test, or match a row in "Patterns to cut"? Fix it.
7. Run `npx gh-wat-dis lint` as a backstop. It catches broken rendering and gross shape errors, not weak writing.

| Not this | This |
|---|---|
| This PR refactors the auth flow to be more robust. | Four services each validate tokens, and two disagree on expiry. This moves validation into the API gateway and removes it from the services. |
| There may be some performance implications. | Unknown: p95 latency of `GET /orders` under the new join. Check: `k6 run perf/orders.js`. |
| Various files were updated to support the change. | 14 files in `packages/web` import `formatPrice`. All 14 change. |
| We should probably consider adding an index. | Add an index on `orders(customer_id, created_at)`. |
| This is not just a bug fix. It is a rethink of how retries work, underscoring our commitment to reliability. | The worker keys each charge on `event.id`, so a retry cannot charge the card twice. |
| The result? Checkout that works. Every time. | Checkout returned 0 duplicate charges in 10,000 replayed webhooks. |
