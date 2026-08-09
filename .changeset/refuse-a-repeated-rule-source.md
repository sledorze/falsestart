---
'@sledorze/falsestart': minor
---

Naming `--rules` twice, or `--preset` twice, is now **refused** instead of ranked.

**This can turn a previously-working command line into a refusal.** `--rules ./a --rules ./b` used to
load only `./b`, and `--rules pkg:@acme/rules --rules ./local` loaded only the package — whichever
was written first, so "the last one wins" was not even the rule. Either way one source the caller
explicitly named was silently discarded, and `--doctor` printed a single `rules` row for the winner,
so nothing anywhere said a second source had been dropped.

That is the failure this tool exists to prevent, and it is the exact argument that kept `--preset`
and `--rules` refusing each other until they could genuinely combine: silently preferring one runs a
different rule set than the caller named.

One `--preset` and one `--rules` per invocation still combine into a union. Layering more than that
still means more hook entries — `--preset all` takes every shipped rule set if that is what you were
reaching for.

Also reported by `--doctor`: a path named with `--path` that is in scope but reachable only by rules
that can advise, never block. `--path` is asked as a CI gate for "is this guarded", and a bare count
answered a different question.
