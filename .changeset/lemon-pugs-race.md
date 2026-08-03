---
'@sledorze/falsestart': patch
---

The packaging and repository furniture a published library is expected to carry.

Measured against `@sledorze/cairn`, the published sibling, and against what a consumer of any npm
package looks for:

- **`publishConfig.provenance` was missing.** The release workflow already grants
  `id-token: write # npm provenance`, so provenance was requested in permissions and never actually
  enabled. cairn has it; this now does too.
- **No `bugs` or `homepage`.** npm renders both on the package page, and their absence is why
  "report an issue" had nowhere to point.
- **No `SECURITY.md`.** It matters more than usual here: falsestart _imports_ your
  `falsestart.config.ts` to read it, which executes it, and it judges the text a write tool carries
  rather than the filesystem — so a shell redirect writes a file it never sees. Both are stated
  where someone deciding whether to trust it will look.
- **No `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue or PR templates, or `dependabot.yml`.** The
  bug template asks for `--doctor` output first, since "is it enforcing anything at all" is the
  first question. The rule template asks for the code that must _not_ be blocked, which is the half
  that gets forgotten. Dependabot groups `effect` and `@effect/*` together, because an update there
  is a behaviour change — rules name its APIs — rather than a routine bump.
- **No badges.** CI and licence only; an npm version badge would 404 until this actually publishes.

Also: `main` had no branch protection at all, so a pull request could merge with CI red, and a
branch could merge without ever being current with main. `build-test` is now a required check,
enforced on admins, with force pushes and deletions refused and history kept linear.

`private: true` stays, so none of this publishes yet — that remains a deliberate decision rather
than an oversight.
