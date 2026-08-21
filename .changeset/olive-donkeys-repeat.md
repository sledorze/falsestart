---
'@sledorze/falsestart': minor
---

Mark the `effect` peer dependency optional, so a CLI-only install stops pulling in a framework it
does not use.

`falsestart`'s two entry points have different needs, and only one of them was declared. Measured by packing the
tarball and installing it as a consumer, under npm and pnpm defaults:

- the **`falsestart` binary** — the hook, and the reason almost everyone installs this — is bundled
  by `bundle-cli` and carries **zero** runtime `effect` imports. It judges a write and denies it
  correctly with no `effect` present at all.
- the **programmatic API** (`import { … } from '@sledorze/falsestart'`) genuinely loads the
  consumer's copy: `Cannot find package 'effect'` without it.

A required peer applied the API's requirement to everyone. With `peerDependenciesMeta.effect.optional`
(the flag `@effect/platform-node` already carried), a consumer with no `effect` installs falsestart
alone instead of also acquiring `effect@4.0.0-rc.111`.

**This is a behaviour break for LIBRARY consumers, which is why it is a minor.** While the peer was
required, every package manager installed `effect` silently, so `import '@sledorze/falsestart'`
worked straight after `pnpm add -D @sledorze/falsestart`. It no longer does — it fails with
`Cannot find package 'effect'` until you run `pnpm add effect @effect/platform-node`. Both READMEs
said the library worked straight after install; both now say what it needs. Hook users, who are
almost everyone, are unaffected and get a 5-package install instead of 14.

**What this does NOT do, stated because the obvious assumption is wrong:** it does not rescue a
consumer who already has an incompatible `effect`. `optional` suppresses the _missing_-peer error,
not the _conflicting_-peer one — an existing `effect@4.0.0-beta.102` still fails `npm install` with
`ERESOLVE`, exactly as it does with the peer required. Verified in both configurations:

| consumer state                     | peer required                          | peer optional           |
| ---------------------------------- | -------------------------------------- | ----------------------- |
| already on `effect@4.0.0-beta.102` | ERESOLVE, not installed                | ERESOLVE, not installed |
| no `effect` at all                 | installs + pulls `effect@4.0.0-rc.111` | installs, no `effect`   |

So anyone on the Effect 4.0 beta line still has to move to `rc.111` to take this release. That is
the deliberate consequence of the peer floor being honest about what CI tests, and it is disclosed
in that change's own note rather than softened here.

The README already tells API users to `pnpm add effect` themselves, which is now the accurate
instruction rather than an incidental one.
