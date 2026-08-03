# AGENTS.md — summary

The conventions this repository holds contributors to. Five of them.

**Documentation summaries.** Every Markdown file past the line threshold has a sibling
`X.summary.md`; every in-scope directory has a `_SUMMARY.md` linking to all of its children.
Freshness is tracked by content hash in `.cairn/` sidecars, outside the docs themselves, so it
survives clone and CI. `--refs` extends this to the _content_ of source files a doc links to, so a
doc goes stale when what it describes changes rather than only when a path breaks. Author the prose,
then `pnpm stamp`, then `pnpm check`.

**Releases** run on Changesets and are gated off by default behind a repository variable; a
user-facing change should carry a changeset written for someone who will never read the PR.

**Content-mutation safety.** Anything that writes back to a file a person authored must decide _what
it may touch_ structurally — by path or declared role — never by a content pattern alone. A regex can
always fire on a file it was not meant for. Pair such a change with a negative test proving an
adjacent, similar-looking file is left alone.

**Shipping one iteration well.** Full local verify before every push. Dogfood the real behaviour
against the scenario a feature is meant to catch, including the negative case, then convert that
proof into a permanent test. Treat a structural claim in a doc as unverified until checked, not
merely re-read. One concern per PR, branched off the right parent.
