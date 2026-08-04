---
'@sledorze/falsestart': minor
---

Parse each file with the grammar its extension implies, not the one its rule happens to declare.

A rule's `language` in falsestart means "parse it as this", not "only these files" — that is what
lets a single rule cover `.ts`, `.mts` and `.js`. Every shipped rule says `language: tsx`, so every
TypeScript file was being parsed with the **TSX** grammar. The two genuinely differ: TSX reads
`<string>` as the start of a JSX element where TypeScript reads it as a cast, and after one of
those, TSX cannot see the rest of the file.

Measured over 424 real `.ts` files, that hid three findings from the TypeScript grammar, including
a real `try`/`catch` in a file where a template literal made the TSX parser lose its place. Small,
and a missed violation regardless, which is the one kind of wrong this tool cannot afford.

`.ts`, `.mts` and `.cts` are now parsed as TypeScript, `.tsx` as TSX, and the `.js` family as
JavaScript. A rule for a language outside that family — `css`, `html` — keeps its own grammar,
because a `.css` extension says nothing about which JavaScript parser to use.

**Two things may change for you.** A repo may see findings it did not before: falsestart's own
corpus run went from 3,947 to 3,949. And a rule whose pattern is TypeScript-specific, pointed at a
`.js` file, now **fails loudly** rather than quietly matching nothing — `$X as any` is not a valid
pattern under the JavaScript grammar. That is the better failure: a rule that cannot run on the
files it is aimed at should say so.

Found by hydrating the rules for the upstream ast-grep CLI and comparing the two engines over a
real corpus. Neither was a superset of the other, and chasing the disagreement found this.
