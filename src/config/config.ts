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
 * An override for a rule that is not loaded is refused rather than ignored: a typo'd id would
 * otherwise be a scope change that silently never happens, which is exactly the failure this tool
 * exists to catch elsewhere.
 */
import { Data, Effect, Schema } from 'effect'
import type { Rule } from '../checking/index.ts'

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

    const declared = document['rules']
    if (declared === undefined) {
      return Effect.succeed(EMPTY_CONFIG)
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

    return reasons.length > 0 ? Effect.fail(new ConfigError({ reasons })) : Effect.succeed({ rules: overrides })
  })

export const parseConfig = (source: string, origin: string): Effect.Effect<Config, ConfigError> =>
  // `Schema.UnknownFromJsonString` rather than `JSON.parse`: the malformed-document case lands in
  // the error channel instead of being thrown and re-caught, and the result is `unknown` because it
  // genuinely is — no assertion needed before `validateConfig` looks at it.
  Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(source).pipe(
    Effect.mapError((cause) => new ConfigError({ reasons: [`${origin}: invalid JSON (${String(cause)})`] })),
    Effect.flatMap((document) => validateConfig(document, origin)),
  )

/**
 * Re-scopes loaded rules according to `config`.
 *
 * Rules keep their order and everything the override does not name.
 */
export const applyScopeOverrides = (
  rules: readonly Rule[],
  config: Config,
): Effect.Effect<readonly Rule[], ConfigError> =>
  Effect.suspend(() => {
    const known = new Set(rules.map((rule) => rule.id))
    const unknown = Object.keys(config.rules)
      .filter((id) => !known.has(id))
      .map((id) => `no rule named ${id} is loaded, so its scope override would do nothing`)

    if (unknown.length > 0) {
      return Effect.fail(new ConfigError({ reasons: unknown }))
    }

    return Effect.succeed(
      rules.map((rule) => {
        const override = config.rules[rule.id]
        return override === undefined ? rule : { ...rule, ...override }
      }),
    )
  })

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
