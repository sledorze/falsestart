---
'@sledorze/falsestart': minor
---

Two new `clean-code` rules: `no-empty-catch` and `no-hardcoded-credential`.

**This can turn a previously-passing repo red.** Both are `error` severity and both are in
`clean-code`, so `--preset clean-code` and `--preset all` gain them automatically. They are also the
first `clean-code` rules that reach JavaScript, so a JavaScript repo using that preset goes from
being guarded by nothing to being guarded by two rules.

`no-empty-catch` matches a catch block with nothing in it at all. A block containing a comment is
deliberately **not** matched: the difference between swallowing an error and deciding to ignore one
is whether anyone wrote down why, and the comment is that record. It doubles as the escape hatch, so
the rule needs no configuration to stay out of the way. Under `--preset all` an empty catch also
trips `no-try-catch`, which forbids try/catch outright — two different objections, kept separate
because this one exists for repos where try/catch is entirely legitimate.

`no-hardcoded-credential` matches the **format** of a credential, never the name of the variable
holding it: AWS access key ids, GitHub tokens, Slack tokens, Stripe live secret keys, and PEM
private key headers. That distinction is the design. A name-based rule — anything assigned to
`password`, `apiKey`, `token` — fires on `const field = 'password'`, on form labels, on fixtures and
on documentation about authentication, and the noise gets it turned off. An issuer-assigned format
is a structural fact about the value.

The trade is worth stating plainly: it catches credentials that announce themselves and misses ones
that do not. A bare `const password = 'hunter2'` is invisible to it, because nothing distinguishes
that string from any other. It is a floor, not a boundary — pair it with a scanner over history,
which is a different job from guarding a single write. `sk_test_` keys are ignored; only `sk_live_`
is a secret.

Both exempt test files, like every other shipped rule. A fixture full of realistic-looking keys is
normal, and a rule that blocks writing one is a rule people disable.
