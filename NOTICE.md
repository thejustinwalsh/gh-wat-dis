# Notices

gh-wat-dis is MIT licensed. See `LICENSE`.

## Writing style

`skills/gh-wat-dis/references/style.md` adapts ideas from
[aaddrick/attention-control](https://github.com/aaddrick/attention-control)
(MIT, Copyright (c) 2026 aaddrick; portions Copyright (c) 2026 Ayoub Ghriss,
derived from [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd)).
Its language layer builds on L1nefeed's `asd-ste100` gist.

The sections "Specific beats general", "Patterns to cut" and the word lists
adapt ideas from [petergyang/no-ai-slop](https://github.com/petergyang/no-ai-slop)
(MIT, Copyright (c) 2026 Peter Yang).

gh-wat-dis paraphrases these rules for GitHub issues, pull requests and
milestones. It copies no text from them and none of those authors endorse
gh-wat-dis.

## Architecture notation

Diagram types and the notation checklist follow the [C4 model](https://c4model.com)
by Simon Brown (CC BY 4.0).

## Dependencies

- [elkjs](https://github.com/kieler/elkjs) lays out diagrams. EPL-2.0. gh-wat-dis depends on it and does not modify or bundle it.
- [@resvg/resvg-js](https://github.com/thx/resvg-js) draws a PNG of a diagram for `diagram --png`. MPL-2.0. gh-wat-dis depends on it and does not modify or bundle it.
- [@ast-grep/napi](https://github.com/ast-grep/ast-grep) parses source for impact analysis. MIT.
