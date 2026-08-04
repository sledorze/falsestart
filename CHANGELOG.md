# @sledorze/falsestart

## 0.2.0

### Minor Changes

- d97f714: `--doctor` now names any rule whose config override covers fewer file extensions than the rule
  ships with, and the same comparison is exported as `findNarrowedScopes`.

  A scope override replaces a rule's `files` rather than merging into them. That is the right
  behaviour — a merge could never remove anything — but it means an override written to add a single
  file exemption has to restate the rule's entire glob, and any extension missing from that
  restatement is silently no longer guarded. Nothing fails, because there is typically no file with
  that extension in the repo yet for anyone to notice going unchecked.

  falsestart's own config had been doing this since the release that added `.mts`/`.cts` coverage:
  two overlooked extensions on `no-type-assertion`, six on `no-json-global`, full test suite green,
  `--doctor` reporting a healthy installation the whole time. The new report is what finally named
  it.

  ```
  config   falsestart.config.ts — 1 override(s): no-try-catch
           no-try-catch stops covering .mts, .cts, .js, .jsx, .mjs, .cjs — the override replaces the rule's own files
  ```

  Reported, never refused, and the exit code is unchanged: narrowing is what overrides are for, and
  only you know whether a particular narrowing was meant. Only the language dimension is compared,
  never directories, because that is where narrowing is almost always an accident of restating a glob
  rather than a decision someone made.

  `findNarrowedScopes(shipped, scoped)` returns the same data if you would rather assert it in your
  own test suite than read it in a report.

- 81a983a: Two new `clean-code` rules: `no-empty-catch` and `no-hardcoded-credential`.

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

- 5ae2a50: Fifteen of the twenty shipped rules now cover JavaScript as well as TypeScript.

  **This can turn a previously-passing repo red, and that is the point of the change.** Any repo
  using `--preset effect` or `--preset all` that writes `.js`, `.jsx`, `.mjs` or `.cjs` files was
  being told nothing about them. Those files are now judged, so writes that always broke a rule will
  start being blocked — not because the rules changed, but because they finally reach the files. A
  JavaScript repo that installed falsestart got a guard that was registered, healthy and completely
  inert; that is what this fixes.

  The widened rules match runtime constructs that exist identically in both languages: `no-await`,
  `no-json-global`, `no-manual-effect-run-in-tests`, `no-new-promise`, `no-process-env`,
  `no-process-exit`, `no-raw-coercion`, `no-raw-error`, `no-raw-fetch`, `no-test-lifecycle-hooks`,
  `no-then-catch`, `no-throwing-decode`, `no-try-catch`, `no-unsafe-api` and `no-vi-mocking`. Each is
  tested against real JavaScript rather than assumed to work there.

  Five rules stay TypeScript-only — `no-as-any`, `no-as-never`, `no-double-cast`,
  `no-type-assertion`, `prefer-smart-constructor` — because valid JavaScript cannot contain an `as`
  expression or a `const x: T = {…}` annotation for them to find. Worth knowing if you were relying
  on the opposite: they are not incapable of firing on a `.js` file, since the parser follows a
  rule's `language: tsx` rather than the file's extension. Scoping them there would claim coverage a
  JavaScript file can never trip.

  To keep the old behaviour, re-scope the rules you want narrowed in `falsestart.config.ts`:

  ```ts
  export default {
    rules: { 'no-try-catch': { files: ['src/**/*.{ts,tsx,mts,cts}'] } },
  } satisfies FalsestartConfig
  ```

  JavaScript's own type assertion, a JSDoc cast like `/** @type {any} */ (value)`, is still caught by
  no shipped rule.

- 461bcea: Add `--warn-unscoped`, which reports a judged write that no rule is scoped to instead of passing it
  in silence.

  Without it, "no rule looked at this file" and "every rule looked and found nothing" are the same
  observable outcome: nothing. A repo can wire the hook up correctly, see it registered and healthy,
  and have it check none of the files being written — the shipped rules match only
  `**/*.{ts,tsx,mts,cts}`, so a JavaScript repo gets a guard that is installed and inert. That is how
  this was found: a probe file carrying a hardcoded credential was written to a `.js` path, went
  through untouched, and was reported as "falsestart does not block".

  The flag is non-blocking and cannot pre-empt a denial — a rule that could block is by definition a
  rule that applies. It does not change any existing decision, so no previously-passing repo can
  start failing because of it.

  It is refused with `--doctor` rather than accepted and ignored: `--doctor` reads no payload to
  report on, and its scope block already prints a rule count per probed path, where a `0` is the same
  fact this flag reports at write time.

  It is off by default because the signal is noisy, and that is worth knowing before turning it on.
  Measured against the shipped presets, it fires on every `.md`, `.json`, `.yml` and `.js` write
  under all three, and on test files under `clean-code` only — whose four rules all ignore them,
  while `effect` carries three rules that exist to judge them.

### Patch Changes

- 87c9da0: Correct the install instructions, which predated the first release and told you to install
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

## 0.1.0

### Minor Changes

- aa0b31b: First release.

  falsestart runs as a Claude Code `PreToolUse` hook and blocks risky code patterns at the moment an
  agent writes them, before the file lands. Rules are [ast-grep](https://ast-grep.github.io)
  documents, so the same file stays readable by the upstream CLI.

  **Twenty rules, in two presets.** `clean-code` is four TypeScript rules and assumes nothing else:
  `no-as-any`, `no-as-never`, `no-double-cast`, `no-type-assertion`. `effect` is sixteen that assume
  an Effect codebase — they forbid `await`, `try/catch`, `new Promise`, `.then`, `JSON.parse`,
  `fetch`, `process.env`, `process.exit`, raw `Error`, raw coercion, Effect's `Unsafe`/`OrThrow`
  escape hatches and its throwing `Sync` decoders, plus three that apply only to test files. Pick
  deliberately: on an ordinary async function `--preset all` produces seven blocks, which is correct
  in an Effect repo and wrong everywhere else. Every rule is `error` severity and scoped to
  `**/*.{ts,tsx,mts,cts}`.

  **Rules from anywhere.** `--preset <name>` for the shipped set, `--rules <dir>` for your own,
  `--rules pkg:@acme/falsestart-rules` for another package's.

  **Per-repo scoping without editing rules.** `falsestart.config.{ts,mts,js,mjs,json}` re-scopes any
  loaded rule's `files`/`ignores`. A TypeScript config is type-checked against the exported
  `FalsestartConfig`, so a mistyped rule id is a compile error in your editor. An override naming a
  rule that is not loaded is an error rather than a no-op.

  **`--doctor`.** Every misconfiguration a hook can have degrades to the same place — exit 1, a line
  on stderr the runtime swallows, and the write proceeding — so a hook that enforces nothing looks
  exactly like one with nothing to say. `--doctor` reports what was resolved, how many rules reach
  each of five probe paths, and sends a real violation through the real decision path. Read the scope
  block: a nested probe path is what exposes a `src/**.ts` glob that guards top-level files only.

  **Also exported as a library**, for building your own checks: `checkFile`, `loadRules`, `parseRule`,
  `appliesTo`, `decide`, `respond`, `diagnose`, config helpers and the rule-authoring test helpers.

  ### Known limits, stated rather than discovered
  - **`Bash` is not judged.** falsestart inspects the text a write tool carries, so a heredoc or shell
    redirect writes a file it never sees. A guard rail, not a sandbox.
  - **Matching is syntactic.** `import { Chunk as C }` then `C.headUnsafe(c)` is not matched; a local
    object named `Chunk` is. Rules record spellings, not APIs.
  - **`.js`, `.jsx`, `.mjs`, `.cjs` are excluded by design.** The assertion rules match syntax that
    does not exist in JavaScript, and `.js` in a TypeScript repo is usually generated or build code.
  - **A `.ts` config is type-stripped and imported without a filesystem location**, so it may use
    type-only imports but not value imports. Use `.mjs` if you want the `makeConfigUnsafe` smart
    constructor.
  - **`no-unsafe-api` covers the root `effect` import only.** Twenty-one risky APIs live in
    `effect/unstable/*` subpaths and are not matched; widening would pull in `Headers` and `Worker`,
    which are ordinary identifiers.
