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
 * `stripTypeScriptTypes` and importing the result is the cheapest correct option. It is used because
 * no Effect service exposes the capability at all, not for convenience. Direct `node:` imports are
 * confined to this file and `cli.ts` — module resolution, path-to-URL and type stripping, none of
 * which Effect models — and nowhere else in the codebase.
 *
 * ## What a TypeScript config may contain
 *
 * The stripped module is imported from a `data:` URL, which has no filesystem location to resolve a
 * specifier against. So a config may use TYPE-only imports — which are erased — and `node:`
 * builtins, which need no location, but not a PACKAGE or RELATIVE value import: `import picomatch
 * from 'picomatch'` and `import './helper.ts'` both fail with `ERR_UNSUPPORTED_RESOLVE_REQUEST`.
 *
 * That leaves more room than "types only" suggests, and the room is the point: `execSync` resolves,
 * so a config can compute a rule's SCOPE at load time — shell out, build a list of paths, emit
 * globs. Pinned in `respond.test.ts` in both directions, because the narrow claim and the wide one
 * fail differently. The type-only import is still what `satisfies FalsestartConfig` needs:
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

const dataUrl = (javascript: string): string =>
  `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`

const stripAndImport = (source: string, origin: string): Effect.Effect<Config, ConfigError> =>
  Effect.gen(function* () {
    const javascript = yield* Effect.try({
      catch: (cause) => failure(`${origin}: is not valid TypeScript (${String(cause)})`),
      try: () => stripTypeScriptTypes(source),
    })

    return yield* validateConfig(yield* importDefault(dataUrl(javascript), origin), origin)
  })

const loadTypeScript = (
  configPath: string,
  origin: string,
): Effect.Effect<Config, ConfigError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const source = yield* fs
      .readFileString(configPath)
      .pipe(Effect.mapError((cause) => failure(`${origin}: cannot be read (${String(cause)})`)))

    return yield* stripAndImport(source, origin)
  })

/**
 * Why a frozen `.js`/`.mjs` config loses package and relative imports, said where it happens.
 *
 * The freeze substitutes bytes for all four formats, so every format is imported from a `data:` URL,
 * which has no filesystem location to resolve a specifier against. That is a real capability loss for
 * the one format that had it, and the alternative — verify the file, then import it from its path —
 * is a window an agent can write into between the two steps. A loud failure naming its own escape
 * hatch is the honest version of that trade.
 */
const FROZEN_IMPORT_NOTE =
  'a config read from a ref is imported from a data: URL, which has no location to resolve a ' +
  'package or relative import against; pass --freeze=off to import it from disk'

/**
 * Loads the bytes a ref committed, for whichever format the path names.
 *
 * The working tree is never stat'ed or read here — not even to check the file is there. Gating the
 * frozen path on the file's existence would make `rm falsestart.config.json` a one-command disarm.
 */
const loadFrozenConfig = (extension: string, source: string, origin: string): Effect.Effect<Config, ConfigError> => {
  if (extension === '.json') {
    return parseConfig(source, origin)
  }

  const imported =
    extension === '.ts' || extension === '.mts'
      ? stripAndImport(source, origin)
      : importDefault(dataUrl(source), origin).pipe(Effect.flatMap((exported) => validateConfig(exported, origin)))

  return imported.pipe(Effect.mapError((error) => new ConfigError({ reasons: [...error.reasons, FROZEN_IMPORT_NOTE] })))
}

/**
 * Loads the config at `configPath`.
 *
 * A path given explicitly must exist: asking for a config that is not there is a misconfiguration,
 * not an absence.
 */
export const loadConfigFile = (
  configPath: string,
  frozen?: string | undefined,
): Effect.Effect<Config, ConfigError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const origin = configPath

    if (frozen !== undefined) {
      return yield* loadFrozenConfig(path.extname(configPath), frozen, origin)
    }

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
 * The default-named config files present in `directory`, as full paths.
 *
 * Shared with the doctor rather than duplicated: it reports which config was picked up, and a second
 * copy of this scan would be a second thing to keep in step with `DEFAULT_CONFIG_CANDIDATES`.
 *
 * With `frozen`, "present" means present AT THE REF, keyed by basename, and the directory is never
 * read. Discovery has to be frozen as well as content: adding a second config file beside a
 * committed one breaks the load, and a broken load is an allowed write with a stderr line the agent
 * runtime discards — so freezing only the bytes would leave that open by adding a file.
 */
export const findDefaultConfigs = (
  directory: string,
  frozen?: ReadonlyMap<string, string> | undefined,
): Effect.Effect<readonly string[], never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    if (frozen !== undefined) {
      return DEFAULT_CONFIG_CANDIDATES.filter((candidate) => frozen.has(candidate)).map((candidate) =>
        path.join(directory, candidate),
      )
    }

    const present: string[] = []
    for (const candidate of DEFAULT_CONFIG_CANDIDATES) {
      const full = path.join(directory, candidate)
      const exists = yield* fs.exists(full).pipe(Effect.orElseSucceed(absent))
      if (exists) {
        present.push(full)
      }
    }

    return present
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
  frozen?: ReadonlyMap<string, string> | undefined,
): Effect.Effect<Config, ConfigError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const present = yield* findDefaultConfigs(directory, frozen)

    const [only, ...rest] = present
    if (only === undefined) {
      return EMPTY_CONFIG
    }
    if (rest.length > 0) {
      return yield* Effect.fail(
        failure(`more than one falsestart config found (${[only, ...rest].join(', ')}); keep one`),
      )
    }

    // `frozen` holds every candidate `findDefaultConfigs` just returned, so the lookup is a lookup
    // and not a fallback: there is no arrangement in which this reaches the working tree.
    return yield* loadConfigFile(only, frozen?.get(path.basename(only)))
  })
