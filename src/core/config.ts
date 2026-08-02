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
import { Data, Effect } from 'effect'
import type { Rule } from './rule.ts'

export interface ScopeOverride {
  readonly files?: readonly string[]
  readonly ignores?: readonly string[]
}

export interface Config {
  readonly rules: Readonly<Record<string, ScopeOverride>>
}

export class ConfigError extends Data.TaggedError('ConfigError')<{
  readonly reasons: readonly string[]
}> {}

/** No file, no overrides — configuration is optional, unlike the rule tree itself. */
export const EMPTY_CONFIG: Config = { rules: {} }

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isGlobList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')

const readOverride = (value: unknown, path: string): ScopeOverride | string => {
  if (!isMapping(value)) {
    return `${path} must be an object`
  }

  const { files, ignores } = value
  if (files !== undefined && !isGlobList(files)) {
    return `${path}.files must be an array of glob strings`
  }
  if (ignores !== undefined && !isGlobList(ignores)) {
    return `${path}.ignores must be an array of glob strings`
  }
  if (files === undefined && ignores === undefined) {
    return `${path} names neither files nor ignores, so it would change nothing`
  }

  return {
    ...(files === undefined ? {} : { files }),
    ...(ignores === undefined ? {} : { ignores }),
  }
}

export const parseConfig = (source: string, origin: string): Effect.Effect<Config, ConfigError> =>
  Effect.try({
    catch: (cause) => new ConfigError({ reasons: [`${origin}: invalid JSON (${String(cause)})`] }),
    try: () => JSON.parse(source) as unknown,
  }).pipe(
    Effect.flatMap((document) => {
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
    }),
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
