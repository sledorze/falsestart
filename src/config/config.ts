/**
 * Per-repository configuration: which folders a rule applies to.
 *
 * A rule ships with `files`/`ignores` chosen by its author, who does not know your layout. Without
 * a way to change that, "narrow the globs" — the correct answer when a rule fires somewhere it
 * should not — means editing a vendored file under `node_modules`, which the next install
 * destroys. The only remaining options are to drop the rule entirely or to live with the noise,
 * and neither is a real answer.
 *
 * An override names only the keys it changes. Naming `files` must not silently discard the
 * author's test-file exemption, because losing an exemption widens a rule, and a rule that
 * suddenly polices files it never did is indistinguishable from a bug.
 *
 * An override for a rule that is not loaded is REPORTED rather than refused — see
 * `findUnappliedOverrides` for why that reversed, which is a story about what the refusal cost
 * rather than about whether a typo matters.
 */
import { Data, Effect, Schema } from 'effect'
import type { Rule } from '../checking/index.ts'
import { appliesTo, samplePath, SOURCE_EXTENSIONS } from '../checking/index.ts'

export interface ScopeOverride {
  /**
   * Required. An override exists to answer "where does this rule apply in THIS repo", and an
   * override that only adjusts `ignores` leaves that answer implicit — inherited from an author
   * who never saw your layout. Making it mandatory means every override states it outright.
   */
  readonly files: readonly string[]
  readonly ignores?: readonly string[]
}

export interface Config {
  /**
   * Paths a scan should leave alone, for this repository, once.
   *
   * Belongs here rather than only on the command line because it is a fact about the REPOSITORY,
   * not about one invocation of it. Left as a flag alone, the same list has to be repeated in
   * `lefthook.yml`, in a husky script and in CI, and the copies drift — which is the failure this
   * codebase has already fixed twice, in the shipped rule globs and in its own scope overrides.
   *
   * `node_modules` and `.git` are always excluded and need no entry. `--exclude` adds to this
   * rather than replacing it: a config is the repository's standing policy and a flag is one run's
   * addition to it, so neither can silently drop what the other established.
   */
  readonly exclude?: readonly string[] | undefined
  readonly rules: Readonly<Record<string, ScopeOverride>>
}

export class ConfigError extends Data.TaggedError('ConfigError')<{
  readonly reasons: readonly string[]
}> {
  /**
   * The reasons, as the error's own message.
   *
   * Without this the message is empty, and `makeConfigUnsafe` — whose whole contract is to fail by
   * throwing — reports nothing a reader can act on. An error thrown at a config module's import is
   * the entire error report for that run.
   */
  override get message(): string {
    return this.reasons.join('\n')
  }
}

/**
 * No file, no overrides — configuration is optional, unlike the rule tree itself.
 *
 * `satisfies` rather than a type annotation: an annotated literal asserts a shape nothing checked,
 * which is what `prefer-smart-constructor` objects to, and this cannot go through `makeConfig` —
 * `validateConfig` returns this very value, so building it that way is circular. `satisfies` gets
 * the conformance checked by the compiler without the assertion, and an empty rule set has no
 * invariant left for a smart constructor to establish.
 */
export const EMPTY_CONFIG = { rules: {} } satisfies Config

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isGlobList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')

const readOverride = (value: unknown, path: string): ScopeOverride | string => {
  if (!isMapping(value)) {
    return `${path} must be an object`
  }

  const { files, ignores } = value
  if (!isGlobList(files)) {
    return `${path}.files is required and must be an array of glob strings`
  }
  if (ignores !== undefined && !isGlobList(ignores)) {
    return `${path}.ignores must be an array of glob strings`
  }

  // Refused for the reason `parseRule` refuses it: the globs are matched as an OR, so a leading `!`
  // admits everything it does not name rather than excluding it — an override written to carve out
  // test files silently widened the rule to Markdown, to `.js`, and to the tests themselves.
  const scopeGlobs = [...files, ...(isGlobList(ignores) ? ignores : [])]

  // Refused for the reason `parseRule` refuses it: an empty pattern throws inside the matcher, and
  // the throw is a defect that kills the run with nothing on either stream.
  if (scopeGlobs.some((glob) => glob.trim().length === 0)) {
    return (
      `${path}: files/ignores contains an empty glob. An empty pattern is not "match nothing" — it ` +
      'throws inside the matcher, which kills the run with no output at all.'
    )
  }

  const negated = scopeGlobs.filter((glob) => glob.startsWith('!'))
  if (negated.length > 0) {
    return (
      `${path}: ${negated.join(', ')} — a leading ! is not an exclusion here. The globs are matched as an OR, ` +
      'so a negated one admits everything it does not name. Put exclusions in `ignores`.'
    )
  }

  return {
    files,
    ...(ignores === undefined ? {} : { ignores }),
  }
}

/**
 * Validates an already-parsed config value.
 *
 * Shared by the JSON and module paths: a TypeScript config is type-checked in your editor, but by
 * the time it reaches here it is a plain runtime value that may have been built by code, so it
 * gets exactly the same scrutiny as hand-written JSON.
 */
export const validateConfig = (document: unknown, origin: string): Effect.Effect<Config, ConfigError> =>
  Effect.suspend(() => {
    if (!isMapping(document)) {
      return Effect.fail(new ConfigError({ reasons: [`${origin}: config must be an object`] }))
    }

    const declaredExclude = document['exclude']
    if (declaredExclude !== undefined && !isGlobList(declaredExclude)) {
      return Effect.fail(new ConfigError({ reasons: [`${origin}: exclude must be an array of glob strings`] }))
    }
    const exclude = declaredExclude === undefined ? {} : { exclude: declaredExclude }

    const declared = document['rules']
    if (declared === undefined) {
      return Effect.succeed({ ...EMPTY_CONFIG, ...exclude })
    }
    if (!isMapping(declared)) {
      return Effect.fail(new ConfigError({ reasons: [`${origin}: rules must be an object`] }))
    }

    const overrides: Record<string, ScopeOverride> = {}
    const reasons: string[] = []
    for (const [id, raw] of Object.entries(declared)) {
      const override = readOverride(raw, `${origin}: rules.${id}`)
      if (typeof override === 'string') {
        reasons.push(override)
      } else {
        overrides[id] = override
      }
    }

    return reasons.length > 0
      ? Effect.fail(new ConfigError({ reasons }))
      : Effect.succeed({ ...exclude, rules: overrides })
  })

export const parseConfig = (source: string, origin: string): Effect.Effect<Config, ConfigError> =>
  // `Schema.fromJsonString(Schema.Unknown)` rather than `JSON.parse`: the malformed-document case lands in
  // the error channel instead of being thrown and re-caught, and the result is `unknown` because it
  // genuinely is — no assertion needed before `validateConfig` looks at it.
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(source).pipe(
    Effect.mapError((cause) => new ConfigError({ reasons: [`${origin}: invalid JSON (${String(cause)})`] })),
    Effect.flatMap((document) => validateConfig(document, origin)),
  )

/**
 * Re-scopes loaded rules according to `config`.
 *
 * Rules keep their order and everything the override does not name.
 */
export const applyScopeOverrides = (rules: readonly Rule[], config: Config): Effect.Effect<readonly Rule[]> =>
  Effect.suspend(() =>
    Effect.succeed(
      rules.map((rule) => {
        const override = config.rules[rule.id]
        return override === undefined ? rule : { ...rule, ...override }
      }),
    ),
  )

/**
 * The overrides that named a rule this invocation did not load.
 *
 * Reported rather than refused, and that is a reversal. Refusing looked right — a typo'd id is a
 * scope change that silently never happens, which is the failure this tool exists to catch
 * elsewhere. What it missed is what the refusal COSTS, because this error is raised on the judging
 * path: the guard fails open, so the run exits 1 and the write proceeds **unchecked**, and under
 * `--fail closed` it denies every write in the repository instead. A scope override that does not
 * apply became a guard that does not run.
 *
 * It is also an ordinary state rather than a mistake. Two hook entries — a preset in one, the repo's
 * own tree in the other — auto-discover the SAME config file, so each of them necessarily sees
 * overrides for rules only the other loaded. `--preset` and `--rules` combining removes the common
 * case; it does not remove two local trees, two packages, or two presets.
 *
 * So the id is named, loudly, in `--doctor` — where a fact about the RULE SET belongs, for the
 * reason `fallbacks` is stated there and not on every tool call — and the run proceeds. This follows
 * `findNarrowedScopes`: reported, never refused, because only the reader knows whether a particular
 * override was meant for this invocation.
 */
export const findUnappliedOverrides = (rules: readonly Rule[], config: Config): readonly string[] => {
  const loaded = new Set(rules.map((rule) => rule.id))

  return Object.keys(config.rules).filter((id) => !loaded.has(id))
}

export interface NarrowedScope {
  /** Extensions the shipped rule covered and the override does not. Never empty. */
  readonly lostExtensions: readonly string[]
  readonly ruleId: string
}

/**
 * Which overrides cover fewer languages than the rule they re-scope.
 *
 * An override REPLACES a rule's scope rather than merging into it — the documented behaviour, and
 * the right one, since a merge could never remove anything. The consequence is easy to miss: a
 * config written to add one file exemption has to restate the rule's whole `files` glob, and any
 * extension left out of that restatement is silently no longer guarded.
 *
 * This repo did it to itself. `no-type-assertion` and `no-json-global` were pinned to `{ts,tsx}`
 * to carry a single-file exemption, and stopped covering `.mts` and `.cts` — the two extensions a
 * release had been cut to add — while every test stayed green and the diagnostic said healthy.
 *
 * Reported rather than refused, because narrowing is what overrides are for: `files:
 * ['src/domain/**']` is the documented example, and failing on it would make the feature unusable.
 * Only the LANGUAGE dimension is compared, not directories, because that is where narrowing is
 * almost always an accident of restating a glob rather than a decision someone made.
 */
export const findNarrowedScopes = (shipped: readonly Rule[], scoped: readonly Rule[]): readonly NarrowedScope[] => {
  const byId = new Map(scoped.map((rule) => [rule.id, rule]))

  return shipped.flatMap((original) => {
    const applied = byId.get(original.id)
    if (applied === undefined) {
      return []
    }

    // Sampled from the OVERRIDE's globs, so the directory a probe lands in is one it already
    // admits. An override with no `files` at all admits every path and therefore cannot have
    // narrowed anything — there is nothing to sample and nothing to report.
    const globs = applied.files
    if (globs === undefined) {
      return []
    }

    const lostExtensions = SOURCE_EXTENSIONS.filter((extension) =>
      // One demonstration is enough: a path the shipped rule accepts and the override refuses,
      // differing from a path the override accepts only in its extension.
      globs.some((glob) => {
        const path = samplePath(glob, extension)
        return appliesTo(original, path) && !appliesTo(applied, path)
      }),
    )

    return lostExtensions.length === 0 ? [] : [{ lostExtensions, ruleId: original.id }]
  })
}

/**
 * Smart constructor for a `Config`.
 *
 * falsestart ships a rule telling you to build values through a constructor that owns their
 * invariants rather than asserting a shape onto a literal. An identity `defineConfig(...)` helper
 * would be exactly the assertion that rule objects to: it types the literal and checks nothing, so
 * a config built from a CSV column, an environment variable, or another tool's output is accepted
 * unexamined and only fails later, somewhere else.
 *
 * This takes `unknown` deliberately. A constructor that only accepts an already-correct `Config`
 * has nothing left to verify, and its caller has already done the part that can go wrong.
 *
 * Use `makeConfigUnsafe` when authoring a config file by hand, where a throw at import is the
 * clearest possible failure and there is no error channel to thread.
 */
export const makeConfig = (input: unknown): Effect.Effect<Config, ConfigError> => validateConfig(input, 'config')

/**
 * `makeConfig`, failing by throwing.
 *
 * For a config module, where the failure has nowhere to go but the import that loaded it, and the
 * whole run is about to be abandoned regardless:
 *
 *     export default makeConfigUnsafe({ rules: { 'no-as-any': { files: ['src/**\/*.ts'] } } })
 */
export const makeConfigUnsafe = (input: unknown): Config => Effect.runSync(makeConfig(input))
