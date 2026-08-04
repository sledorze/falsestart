/**
 * Decides which files a rule is allowed to act on.
 *
 * This is the structural half of falsestart's safety story. A rule fires on a file only when
 * that file's PATH puts it in scope — never merely because its CONTENT happened to match. Getting
 * this wrong is silent in both directions: too broad and a rule flags files it was never meant to
 * see, too narrow and a rule quietly stops protecting anything at all. Neither failure announces
 * itself, which is why scoping lives in its own module with its own negative tests.
 *
 * Matching is delegated to `picomatch` rather than a bespoke glob-to-RegExp translation. Hand-
 * rolled translations tend to be subtly wrong at exactly the edges that matter here — brace
 * alternation, `*` versus `**` at a directory boundary, a literal segment that must not match as
 * a substring — and a scoping bug is indistinguishable from "the rule is off".
 */
import picomatch from 'picomatch'
import type { Language } from './rule.ts'

/**
 * The languages a shipped rule can reach, in one place.
 *
 * These lists existed in four independent copies — one per consumer — while the globs built from
 * them are restated 74 times across `rules/*.yml`. That is not a tidiness complaint: a restated
 * list with one entry missing is exactly how `.mts` and `.cts` went unguarded for a release, and
 * then how this repo's own config silently stopped covering them again afterwards. A single
 * definition is what lets `corpus.test.ts` assert that all 74 restatements still agree with it.
 *
 * `.js` and friends are here because fifteen of the twenty rules match runtime constructs that
 * JavaScript has too. The five keying on TypeScript syntax use only the first list.
 */
export const TYPESCRIPT_EXTENSIONS = ['ts', 'tsx', 'mts', 'cts'] as const
export const JAVASCRIPT_EXTENSIONS = ['js', 'jsx', 'mjs', 'cjs'] as const

/** Every extension a shipped rule may be scoped to. */
export const SOURCE_EXTENSIONS: readonly string[] = [...TYPESCRIPT_EXTENSIONS, ...JAVASCRIPT_EXTENSIONS]

/** The brace alternation a rule's `files` glob is written with, built rather than retyped. */
export const extensionGlobGroup = (extensions: readonly string[]): string => `{${extensions.join(',')}}`

/**
 * A filename matching `pattern` but carrying `extension` — `*.test.{ts,tsx}` becomes
 * `file.test.mts`. Everything between the stem and the extension is kept, because that is what
 * distinguishes a test-only rule's scope from an ordinary one's.
 */
const sampleFileName = (pattern: string, extension: string): string => {
  const parts = pattern.split('.')
  const stem = parts.slice(0, -1).map((part) => (part.includes('*') ? 'file' : part))

  return [...stem, extension].join('.')
}

/**
 * A concrete path that `glob` admits, carrying `extension`.
 *
 * Comparing two globs in general is a question about glob semantics with no useful answer;
 * comparing what they ADMIT, at concrete paths, is a question with a concrete one. This is what
 * makes "did that override drop a language?" answerable.
 *
 * The point is to hold the DIRECTORY constant while varying only the language. Probing a fixed
 * `src/a.ts` instead made every directory narrowing — `files: ['src/domain/**']`, the documented
 * use of scope overrides — report as though it had dropped all eight extensions.
 *
 * It lives here rather than beside its caller because it is glob semantics, and glob semantics
 * belong with `appliesTo` — the module docstring's whole argument is that this reasoning is subtle
 * enough to keep in one place with its own negative tests.
 */
export const samplePath = (glob: string, extension: string): string => {
  // Sliced rather than indexed: `lastIndexOf` returning -1 for a glob with no `/` is already the
  // right answer for both halves, so there is no impossible `undefined` branch to write a test for.
  const slash = glob.lastIndexOf('/')
  const last = glob.slice(slash + 1)
  // `**` is a directory wildcard, even though every other trailing segment carrying a dot is a
  // filename.
  const namesAFile = last !== '**' && last.includes('.')

  const head = namesAFile ? glob.slice(0, Math.max(slash, 0)) : glob
  const directories = head === '' ? [] : head.split('/').map((segment) => (segment.includes('*') ? 'probe' : segment))

  return [...directories, namesAFile ? sampleFileName(last, extension) : `file.${extension}`].join('/')
}

/**
 * The grammar a path should be parsed with, when the file's own extension knows better than the
 * rule does.
 *
 * A rule's `language` in falsestart means "parse it as this", not "only these files" — that is
 * what lets one rule cover `.ts`, `.mts` and `.js`. The cost was that `.ts` files were parsed with
 * whatever grammar the rule happened to declare, and for the shipped rules that is TSX. The two
 * genuinely differ: TSX reads `<string>` as the start of a JSX element and TypeScript reads it as a
 * cast, so after one, TSX cannot see the rest of the file. Measured over 424 real `.ts` files,
 * that hid three findings including a real `try`/`catch`.
 *
 * Only the JavaScript family is remapped. A rule declaring `css` or `html` keeps its own grammar,
 * because a `.css` extension says nothing about which JavaScript parser to use and overriding it
 * would break the rule outright.
 */
const FAMILY_GRAMMARS: Readonly<Record<string, Language>> = {
  cjs: 'javascript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  mts: 'typescript',
  ts: 'typescript',
  tsx: 'tsx',
}

const REMAPPABLE: ReadonlySet<Language> = new Set<Language>(['javascript', 'tsx', 'typescript'])

/**
 * Which grammar to parse `filePath` with, given what the rule asked for.
 *
 * The rule's choice is kept whenever the file cannot tell us better — an unknown extension, or a
 * rule for a language outside the JavaScript family.
 */
export const grammarFor = (declared: Language, filePath: string): Language => {
  if (!REMAPPABLE.has(declared)) {
    return declared
  }

  // Sliced rather than split-and-index: `lastIndexOf` returning -1 for a path with no dot is
  // already the right answer, so there is no impossible branch to write a test for.
  const dot = filePath.lastIndexOf('.')

  return dot === -1 ? declared : (FAMILY_GRAMMARS[filePath.slice(dot + 1)] ?? declared)
}

export interface FileScope {
  /** Globs the path must match. Absent means "every path". */
  readonly files?: readonly string[] | undefined
  /** Globs carving exclusions out of `files`. Applied after it, and independently of it. */
  readonly ignores?: readonly string[] | undefined
}

/**
 * Globs are authored with `/`, but a path can arrive with `\` on Windows. Normalising here keeps
 * a rule's scope identical across platforms instead of silently matching nothing on one of them.
 */
const toPosixPath = (filePath: string): string => filePath.replaceAll('\\', '/')

/**
 * Collapses the spellings of a path that mean the same place — `./src/a.ts`, `src//a.ts`,
 * `src/./a.ts` all become `src/a.ts`.
 *
 * A glob is matched against the literal string, so `./src/a.ts` matches **nothing** — not even
 * `**\/*.ts`. That failure is total and completely silent: a rule set reports zero findings on a
 * file it would otherwise block, which is indistinguishable from a clean file.
 *
 * It went unnoticed because the only caller receives Claude Code's `file_path`, which is always
 * absolute and already clean. Any caller that passes paths through — a git hook handing over the
 * files it is about to commit — hits it immediately: lefthook's documented `root:` setting, for
 * scoping a hook to one package of a monorepo, emits exactly `./src/a.ts`, and `find . | xargs`
 * produces the same prefix.
 *
 * `..` is deliberately NOT resolved. Doing so would need the path to be anchored to a real
 * directory to be meaningful, and a scoping decision must not depend on the filesystem — that is
 * how a rule starts behaving differently depending on where the process was started.
 */
const normalise = (path: string): string => {
  const absolute = path.startsWith('/')
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.')
  const joined = segments.join('/')

  return absolute ? `/${joined}` : joined
}

/**
 * Whether any of `globs` admits `filePath`.
 *
 * Exported so nothing else restates it. The same one-liner had already been copied into the
 * exclusion module, and this module's whole argument is that glob semantics belong in one place.
 */
export const matchesAny = (globs: readonly string[], filePath: string): boolean =>
  picomatch.isMatch(filePath, [...globs], { dot: true })

/**
 * Re-expresses a path the way rule globs are written.
 *
 * Rules are authored relative to a project (`src/**\/*.ts`), but a write-time hook reports an
 * absolute path (`/repo/src/a.ts`), and matching one against the other never fires. That failure
 * is completely silent — the rule loads, validates, and reports nothing, which is indistinguishable
 * from a clean file. Normalising the path before it reaches `appliesTo` is what closes it.
 *
 * A path outside `root`, or a path with no known root, is returned unchanged: a rule can still
 * reach it with a leading `**\/`, and inventing a relative path for something that is not actually
 * inside the project would be worse than leaving it alone.
 */
export const toScopingPath = (filePath: string, root: string | undefined): string => {
  const path = normalise(toPosixPath(filePath))
  if (root === undefined) {
    return path
  }

  const base = normalise(toPosixPath(root)).replace(/\/+$/, '')
  // The separator is required: without it `/repo` would swallow `/repo-other`.
  const prefix = `${base}/`

  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/**
 * `true` when `filePath` is in scope for a rule carrying this `files`/`ignores` pair.
 *
 * `ignores` is honoured even when `files` is absent, so a rule can say "everywhere except here"
 * without having to first enumerate everywhere.
 */
export const appliesTo = (scope: FileScope, filePath: string): boolean => {
  const path = toPosixPath(filePath)

  if (scope.files !== undefined && !matchesAny(scope.files, path)) {
    return false
  }

  return !(scope.ignores !== undefined && matchesAny(scope.ignores, path))
}
