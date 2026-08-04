---
'@sledorze/falsestart': patch
---

Correct the install instructions, which predated the first release and told you to install
something else.

The README said the package was `private: true` and to install a `0.0.1` tarball packed from a
checkout. Both stopped being true when `0.1.0` was published. Someone followed the published
instructions, ended up with a pre-implementation copy in `node_modules`, and reported that
falsestart blocked nothing — the tool and their hook wiring were both fine. The command is now
`pnpm add -D @sledorze/falsestart`.

This is a documentation change that needs a release to have any effect: `README.md` and `docs/` are
inside the published `files` array, so until this ships, npm keeps serving the instructions that
caused the problem.

Two smaller corrections in the same area. The claim that installing falsestart also installs
`effect` was true for npm and false for pnpm, which is the package manager the README's own command
uses — and the cause was misattributed to `effect` being a peer, when pnpm's isolated
`node_modules` omits ordinary dependencies such as `picomatch` just the same. And the `--doctor`
sample output showed `falsestart 0.0.1`, so the one line that would have exposed a stale install
was itself printed as though the stale version were expected; it is now elided rather than pinned
to a number that goes stale at every release.
