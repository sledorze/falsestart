/**
 * Judging files that are already on disk.
 *
 * `hook/` adapts an agent protocol: a payload arrives carrying the text a tool is about to write,
 * and the answer is a permission decision. This area adapts a filesystem: paths arrive, their
 * contents are read, and the answer is a report. Same rules, same scoping, different adapter — and
 * deliberately a different area, because the failure modes are different too.
 *
 * It exists because the write-time hook is bypassable by construction. It sees `Edit`, `Write` and
 * `NotebookEdit`, and nothing else: a `Bash` heredoc, a `>` redirect, `git checkout`, `git merge`,
 * `git revert`, a person in an editor, another agent, and every file that predates the hook being
 * installed all reach disk unexamined. A second enforcement point at pre-commit or pre-push closes
 * that, at the cost of being strictly stricter — see the asymmetry noted below.
 *
 * Paths are supplied by the caller and never discovered here. Every git hook runner already
 * computes the file list, and better than this could: lefthook has `{staged_files}` and
 * `{push_files}`, husky users have `git diff --name-only`. Reimplementing that would mean depending
 * on git being installed, on being inside a work tree, and on a ref existing — three new failure
 * modes duplicating what the caller already has correct.
 *
 * The asymmetry a reader has to know about, recorded where the code is rather than only in prose.
 *
 * An `Edit` payload carries only `new_string`, so the hook judges what a change ADDS. A scan parses
 * whole files, so it reports violations the hook never would — including every pre-existing one.
 * Measured over 424 files of real hand-written TypeScript, 64% already carry at least one finding
 * under the shipped rules. Passing only changed files bounds the blast radius per commit; it does
 * not change the odds that a touched file already violates.
 *
 * That is why the report distinguishes findings that are new from findings a baseline has already
 * accepted. Without it, a one-line edit to a legacy file is allowed by the hook and blocked by the
 * scan on lines the author never touched, whose only exits are `--no-verify`, editing config, or
 * fixing unrelated code. A gate that trains people to bypass it is worse than no gate.
 */
import { Data, Effect, FileSystem } from 'effect'
import type { Path } from 'effect'
import type { Finding, Rule } from '../checking/index.ts'
import { appliesTo, checkFile, toScopingPath } from '../checking/index.ts'

/**
 * A path that exists but could not be judged — a directory, an unreadable file, a rule that threw.
 *
 * Separate from "the file is gone", which is an ordinary outcome rather than an error. Raising this
 * is what stops `falsestart scan src/` from reporting a clean run over a directory it never opened.
 */
export class ScanError extends Data.TaggedError('ScanError')<{
  readonly path: string
  readonly reason: string
}> {}

export interface ScannedFile {
  readonly findings: readonly Finding[]
  /** Whether any rule was scoped to this file at all. */
  readonly inScope: boolean
  /** The path as the caller gave it, so the report names what they can act on. */
  readonly path: string
}

export interface ScanReport {
  /** Findings not present in the baseline. These are what fail a run. */
  readonly fresh: readonly Finding[]
  /** Paths that could not be read because they were gone. Counted, never fatal. */
  readonly missing: readonly string[]
  /** Files a rule was actually able to look at. */
  readonly scanned: readonly ScannedFile[]
  /** How many of `scanned` had at least one rule in scope. */
  readonly inScope: number
}

export interface ScanOptions {
  /**
   * How many findings of each `fingerprint` are already accepted.
   *
   * A COUNT rather than a set. Membership alone meant that once one
   * `const x = value as any` in a file was accepted, a second, third and hundredth identical line
   * were accepted too — copy-pasting an already-baselined pattern was invisible to the gate
   * forever. The written file has always listed one entry per occurrence; only the reader
   * collapsed them.
   */
  readonly baseline?: ReadonlyMap<string, number> | undefined
  readonly paths: readonly string[]
  readonly projectDirectory: string
  readonly rules: readonly Rule[]
}

/**
 * Identifies a finding across runs, for baseline comparison.
 *
 * Deliberately excludes the line number. A finding that moves because something was inserted above
 * it is the same finding, and a baseline keyed on line churns into uselessness on the first
 * reformat. Path, rule and the matched text are what make it the same problem.
 */
export const fingerprint = (path: string, finding: Finding): string =>
  // A visible separator rather than whitespace: the baseline is a file people read in a diff, and
  // a path may contain spaces, which would make the parts ambiguous to a reader.
  `${path} :: ${finding.ruleId} :: ${finding.text}`

/**
 * One file: read it, decide what it is called for scoping purposes, and judge it.
 *
 * A path that is gone is counted, not fatal: the caller listed the files, and one can be deleted
 * between that listing and this read. Failing there would block commits at random, for a reason
 * that has nothing to do with the code being committed. Anything else — a directory, a permission
 * error — is raised, because `falsestart scan src/` is the first thing somebody will type and it
 * must not report clean.
 *
 * Symlinks are resolved for SCOPING but reported under the path the caller gave. A rule ignoring
 * `src/vendor/**` should protect the file, not merely the name it was reached by; a report naming a
 * path the caller never mentioned is one they cannot act on.
 */
const scanOne = (
  path: string,
  rules: readonly Rule[],
  projectDirectory: string,
): Effect.Effect<
  { readonly file?: ScannedFile; readonly missing?: string },
  ScanError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    /**
     * A file listed and then deleted is an ordinary race — a hook computes the list, a rebase or a
     * clean removes one — not a defect in the code being committed. Failing there would block
     * commits at random. Anything else is real: a directory, a permission error. Reporting one of
     * those as a clean scan would be the exact silent pass this area exists to remove.
     *
     * The reason nests: `PlatformError` carries a `reason` whose own `_tag` is `NotFound`,
     * `BadResource` (what a directory reads as), `PermissionDenied` and so on.
     */
    const read = yield* Effect.result(fs.readFileString(path))
    if (read._tag === 'Failure') {
      return read.failure.reason._tag === 'NotFound'
        ? { missing: path }
        : yield* new ScanError({ path, reason: read.failure.reason._tag })
    }

    // Resolved so a symlink is scoped by what it points AT: an `ignores` glob should protect the
    // file, not merely the name it was reached by. `orDie` rather than a fallback, because the read
    // above has just succeeded on this path — a failure here is impossible rather than unhandled,
    // and a branch no input can reach is a branch nobody can test.
    const real = yield* Effect.orDie(fs.realPath(path))

    const scopingPath = toScopingPath(real, projectDirectory)

    const applicable = rules.filter((rule) => appliesTo(rule, scopingPath))
    const found = yield* Effect.mapError(
      checkFile(applicable, { content: read.success, path: scopingPath }),
      (cause) => new ScanError({ path, reason: `rule ${cause.ruleId} could not run: ${cause.reason}` }),
    )

    return { file: { findings: found, inScope: applicable.length > 0, path } }
  })

export const scan = (options: ScanOptions): Effect.Effect<ScanReport, ScanError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const { baseline, paths, projectDirectory, rules } = options

    // Bounded concurrency: `checkFile` is per-file independent, and sequentially this costs about
    // 40ms a file, which a 400-file first push would feel.
    const results = yield* Effect.forEach(paths, (path) => scanOne(path, rules, projectDirectory), {
      concurrency: 8,
    })

    const scanned = results.flatMap((result) => (result.file === undefined ? [] : [result.file]))
    const missing = results.flatMap((result) => (result.missing === undefined ? [] : [result.missing]))

    // Consumed as a budget: each accepted occurrence absorbs exactly one finding, so an extra
    // copy of an already-accepted violation is still reported. Order within a file is stable
    // because `checkFile` returns findings in source order.
    const remaining = new Map(baseline)
    const fresh = scanned.flatMap((file) =>
      file.findings.filter((finding) => {
        const key = fingerprint(file.path, finding)
        const accepted = remaining.get(key) ?? 0

        if (accepted === 0) {
          return true
        }
        remaining.set(key, accepted - 1)
        return false
      }),
    )

    return {
      fresh,
      inScope: scanned.filter((file) => file.inScope).length,
      missing,
      scanned,
    }
  })
