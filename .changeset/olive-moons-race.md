---
'@sledorze/falsestart': patch
---

Fixes what a consumer actually receives, and hardens CI.

**Three README links were dead in the tarball.** `files` did not include `CONTRIBUTING.md`,
`SECURITY.md` or `CODE_OF_CONDUCT.md`, so the README rendered on npmjs.com with broken links to all
three — the same defect that once applied to `docs/`, recreated within the hour of adding those
files. They now ship; the link to `AGENTS.md`, which is contributor-internal and stays out of the
package, is absolute instead.

A test now asserts every relative README link resolves to something `files` actually ships. The repo
checkout resolves them either way, which is exactly why nothing noticed twice.

**CI hardening.** The workflow had no `permissions` block, so the default token carried write scope
on every pull request for a job that only reads. It is now `contents: read`, with
`persist-credentials: false` on checkout — both of which `release.yml` already did — plus a
concurrency group so a rapid second push cancels the first.

**`engines` said `>=22.13` and CI tested one version.** Now a matrix of 22 and 24, so the claim is
tested rather than asserted.
