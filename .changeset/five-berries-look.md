---
'@sledorze/falsestart': minor
---

New rule `no-json-global`, and the reference table stops going stale.

`JSON.parse` fails in two directions at once: it **throws** on a malformed document, so the failure
leaves the type system and arrives as an exception wherever it lands, and it is typed `any`, so a
document with the wrong shape parses happily and every access afterwards is unchecked.
`Schema.fromJsonString(Widget)` is one codec covering both — a malformed document and a wrong shape
become the same thing, a decode failure in the error channel, and the value that comes out is typed.
`Schema.UnknownFromJsonString` is the narrower form when parsing and validation are separate phases.

`JSON.stringify` is included as the other half of the same codec. It is partial in ways its
signature hides: it throws on a circular structure or a BigInt, and returns `string | undefined`.

**This can flip a previously-passing repo to failing**, and it will fire on ordinary code — every
`JSON.parse` in a codebase is a match. One exemption is honest and falsestart takes it for itself:
serialising a literal to satisfy an EXTERNAL wire protocol, where the shape is fixed by someone
else's contract and there is no decode side. Parsing is never that case. Scope it per file with a
config override rather than dropping the rule.

Also: `docs/reference.md`'s table of shipped rules had silently fallen **three** rules behind
(`no-throwing-decode`, `no-manual-effect-run-in-tests`, `no-unsafe-api`) while stating a total that
no longer matched, so a reader would have concluded those rules did not exist. It is now complete,
and two tests keep it that way — one asserting every shipped rule id appears in the table, one
asserting the stated count matches. A third closes the matching gap in the corpus test, where an
examples entry naming a rule that does not exist used to pass silently as coverage.
