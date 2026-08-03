/**
 * Finding and loading a repo's config, in JSON or TypeScript.
 *
 * A TypeScript config is the point of this module: it gives you autocomplete on rule ids and a
 * compile error on a typo, in your editor, before falsestart ever runs. JSON gives you neither.
 *
 * ## Why the types are stripped here rather than imported directly
 *
 * `import('./falsestart.config.ts')` does not work on Node 22, which needs `--experimental-strip-
 * types` — a flag falsestart cannot set, because the hook is launched by the agent runtime, not by
 * us. The alternatives were a runtime transpiler dependency (a second native binary on a hot path
 * that already costs ~75ms) or refusing TypeScript configs. Stripping types with Node's own
 * `stripTypeScriptTypes` and importing the result is the cheapest correct option, and it is the
 * one direct `node:` API in this codebase — used because no Effect service exposes the capability
 * at all, not for convenience.
 *
 * ## What a TypeScript config may contain
 *
 * The stripped module is imported from a `data:` URL, which has no filesystem location and so
 * cannot resolve bare specifiers. A config may therefore use TYPE-only imports — which are erased
 * — but not value imports. That is not much of a restriction for a declarative document, and it
 * is exactly what `satisfies FalsestartConfig` needs:
 *
 *     import type { FalsestartConfig } from '@sledorze/falsestart'
 *
 *     export default {
 *       rules: { 'no-as-any': { files: ['src/domain/**\/*.ts'] } },
 *     } satisfies FalsestartConfig
 *
 * A `.js`/`.mjs` config is imported from its real path instead, so it may import whatever it likes.
 */
import { stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Effect, FileSystem, Path } from 'effect'
import type { Config } from './config.ts'
import { ConfigError, EMPTY_CONFIG, parseConfig, validateConfig } from './config.ts'

/**
 * Tried in order when `--config` is not given. A TypeScript config wins over JSON because a repo
 * that has written one has chosen the typed form deliberately.
 */
export const DEFAULT_CONFIG_CANDIDATES = [
  'falsestart.config.ts',
  'falsestart.config.mts',
  'falsestart.config.js',
  'falsestart.config.mjs',
  'falsestart.config.json',
] as const

const failure = (reason: string) => new ConfigError({ reasons: [reason] })

/** A path we cannot stat is treated as absent: the caller's next step is the same either way. */
const absent = () => false

/**
 * A dynamic import is typed `any`, so nothing about the imported shape has been established. Taking
 * it as `unknown` and narrowing says that honestly; asserting `Promise<{ default?: unknown }>` — as
 * this did — claims a shape no one checked, which is what `no-type-assertion` exists to stop.
 */
const hasDefault = (module: unknown): module is { readonly default: unknown } =>
  typeof module === 'object' && module !== null && 'default' in module && module.default !== undefined

/** Imports a module and returns its default export, which is where a config must live. */
const importDefault = (url: string, origin: string): Effect.Effect<unknown, ConfigError> =>
  Effect.tryPromise({
    catch: (cause) => failure(`${origin}: could not be imported (${String(cause)})`),
    try: async (): Promise<unknown> => import(url),
  }).pipe(
    Effect.flatMap((module) =>
      hasDefault(module)
        ? Effect.succeed(module.default)
        : Effect.fail(failure(`${origin}: must have a default export`)),
    ),
  )

const loadTypeScript = (
  configPath: string,
  origin: string,
): Effect.Effect<Config, ConfigError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const source = yield* fs
      .readFileString(configPath)
      .pipe(Effect.mapError((cause) => failure(`${origin}: cannot be read (${String(cause)})`)))

    const javascript = yield* Effect.try({
      catch: (cause) => failure(`${origin}: is not valid TypeScript (${String(cause)})`),
      try: () => stripTypeScriptTypes(source),
    })

    const url = `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
    const exported = yield* importDefault(url, origin)

    return yield* validateConfig(exported, origin)
  })

/**
 * Loads the config at `configPath`.
 *
 * A path given explicitly must exist: asking for a config that is not there is a misconfiguration,
 * not an absence.
 */
export const loadConfigFile = (
  configPath: string,
): Effect.Effect<Config, ConfigError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const origin = configPath

    // A path we cannot even stat is reported the same way as one that is not there: the caller's
    // next step is identical, and a separate branch for it is one no input can reach.
    const present = yield* fs.exists(configPath).pipe(Effect.orElseSucceed(absent))
    if (!present) {
      return yield* Effect.fail(failure(`${origin}: no such config file`))
    }

    const extension = path.extname(configPath)

    if (extension === '.json') {
      return yield* fs.readFileString(configPath).pipe(
        Effect.mapError((cause) => failure(`${origin}: cannot be read (${String(cause)})`)),
        Effect.flatMap((contents) => parseConfig(contents, origin)),
      )
    }

    if (extension === '.ts' || extension === '.mts') {
      return yield* loadTypeScript(configPath, origin)
    }

    // A real module path, so it may import whatever it likes. Not wrapped in `Effect.try`:
    // converting an already-resolved path to a URL has no failure mode a caller could hit, and a
    // handler for it would be a branch no input can reach.
    const resolved = pathToFileURL(path.resolve(configPath)).href

    return yield* importDefault(resolved, origin).pipe(Effect.flatMap((exported) => validateConfig(exported, origin)))
  })

/**
 * Loads the first config that exists among the default names, or none.
 *
 * Absence is not an error here, unlike an explicit `--config`: a repo with nothing to re-scope
 * should not need a file. More than one is refused rather than resolved by precedence — silently
 * picking one of two configs is the kind of quiet wrong answer this tool exists to prevent.
 */
export const loadDefaultConfig = (
  directory: string,
): Effect.Effect<Config, ConfigError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const present: string[] = []
    for (const candidate of DEFAULT_CONFIG_CANDIDATES) {
      const full = path.join(directory, candidate)
      const exists = yield* fs.exists(full).pipe(Effect.orElseSucceed(absent))
      if (exists) {
        present.push(full)
      }
    }

    const [only, ...rest] = present
    if (only === undefined) {
      return EMPTY_CONFIG
    }
    if (rest.length > 0) {
      return yield* Effect.fail(
        failure(`more than one falsestart config found (${[only, ...rest].join(', ')}); keep one`),
      )
    }

    return yield* loadConfigFile(only)
  })
