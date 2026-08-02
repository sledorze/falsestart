---
'@sledorze/falsestart': minor
---

Makes the package actually installable and usable by a consumer.

**The library entry point crashed on import.** `dist/index.js` imports `effect`, but `effect` was
declared an _optional_ peer dependency, so a clean `npm i @sledorze/falsestart` did not install it
and `import('@sledorze/falsestart')` failed with `Cannot find package 'effect'`. It is now a
required peer — a peer rather than a dependency, because a duplicated Effect instance breaks
`Context`/`Layer` identity. `@effect/platform-node` is an optional peer, needed only for the
filesystem-touching helpers.

**The documented setup did not work.** README's `falsestart --rules rules` and the default
`.falsestart/rules` both failed in a real installed project; the only working path was
`--rules node_modules/@sledorze/falsestart/rules`, which appeared in no documentation and breaks
under pnpm's layout. New `--preset all|clean-code|effect` resolves the shipped rules from the
installed package. Combining `--preset` with `--rules` is refused rather than ranked.

**Packaged rules were unreachable.** `import('@sledorze/falsestart/rules/…')` returned
`ERR_PACKAGE_PATH_NOT_EXPORTED`; the `exports` map now includes `./rules/*`.

**`respond` now takes an options object** with an explicit `projectDirectory`. An unnamed config is
looked for there rather than beside the rules — with `--preset` the rules live inside
`node_modules`, where a repo's own config would never be found and rules would silently apply
unchanged.

`engines` is now `>=22.13`, the first Node with `stripTypeScriptTypes`; `>=22` promised support for
versions where a TypeScript config fails at runtime. `publishConfig.access` and the changesets
access are `public`, without which a scoped package publishes restricted or not at all.

CodeQL is gated behind a `codeql-enabled` repository variable, as the release job already is:
without GitHub Advanced Security every run fails at the upload step, and a permanently red `main`
teaches everyone to ignore it.
