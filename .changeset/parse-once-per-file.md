---
'@sledorze/falsestart': patch
---

Parse each file once per language instead of once per rule. Roughly 6× faster, with identical
findings.

`checkFile` called `findViolations(rule, source)` for every applicable rule, and each of those
parsed the source again. With the twenty-two shipped rules, every file was parsed twenty-two times
into twenty-two identical trees.

Profiled on a 762 KB TypeScript file:

|                                   |         |
| --------------------------------- | ------- |
| parse once                        | 94 ms   |
| parse 22× (what it did)           | 2046 ms |
| one match against the parsed tree | 3 ms    |
| all 22 matches against one tree   | 60 ms   |

Ninety-seven per cent of the work was re-reading the same source into the same tree. Rules are now
grouped by the language their matcher is written against, each group parses once, and every rule in
it runs against the shared tree.

Measured end to end, same corpus and same rules:

|           | before    | after    |
| --------- | --------- | -------- |
| 424 files | 18,028 ms | 2,733 ms |
| 20 files  | 1,531 ms  | 290 ms   |

The findings are byte-identical — 3949 before and after — and the whole existing suite passes
unchanged, which is what makes this a refactor rather than a behaviour change.

This matters most on the path that is not benchmarked: the hook runs before **every** tool call an
agent makes, and that cost is paid in a loop someone is watching. `matcher.ts` gains `parseSource`
and `findViolationsIn` for callers that want to amortise a parse themselves; `findViolations` is
unchanged and now composes the two.
