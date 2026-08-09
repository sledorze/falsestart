---
'@sledorze/falsestart': patch
---

Document that a rule can match a comment, because an adopter concluded it could not.

An adoption report reached the opposite conclusion — "ast-grep matches AST nodes, not comments, so a
rule like 'forbid a `*-disable` directive comment' isn't expressible" — spent time on it, and asked
for a README line saying to use a separate text hook instead. A comment is a node like any other:
`kind: comment` selects it and `regex` says which.

```yaml
rule:
  kind: comment
  regex: '-disable'
```

One `comment` kind covers `//`, `/* */`, JSDoc and a trailing comment on a line of code, so there is
no separate kind to write for block comments.

The part worth having in writing is the negative: it does **not** fire on a string containing the
same text, because that is a different node. A text-matching hook cannot tell `// eslint-disable` from
`const s = 'eslint-disable'`, so it fires on documentation about suppression directives and on
fixtures — and a rule that noisy is a rule people turn off. That is the argument for doing it
structurally, and it is now the argument the docs make.

One `comment` kind covers those four forms; a `#!` shebang (`hash_bang_line`) and the Annex B
`<!-- -->` form legal in a `.js` script (`html_comment`) are separate kinds it does not see, and the
prose says so rather than claiming every comment form.

Docs only; no behaviour changes. The snippet is pinned by a test that parses it out of the page and
runs it through the real engine — every comment form the prose names, the string it must not fire
on, and each of the eight extensions its `files` glob advertises.
