/**
 * What to say when falsestart itself throws.
 *
 * `runMain` is invoked with `disableErrorReporting`, and the reasoning behind that is sound for
 * every FAILURE: each one has already been written to stderr in the shape the hook contract
 * expects, so re-reporting would double it. It does not hold for a DEFECT. A throw escapes every
 * `Effect.result` boundary in the program, so nothing wrote anything — and the process exited with
 * stdout and stderr both empty.
 *
 * Measured with a single empty string in a rule's `files`, which throws inside picomatch: exit 1,
 * 0 bytes, 0 bytes, in every mode — including `--doctor`, the command whose entire job is to say
 * what broke. That input is refused at load now; this exists for the next one, because the failure
 * mode is far worse than the cause.
 *
 * Kept as a pure function so the exit-code law can be tested without a process. Reading the agent
 * from `argv` rather than from parsed options is deliberate: a defect can happen before parsing.
 */

/** The exit code `scan` uses for "the gate is broken", distinct from "your code has violations". */
const SCAN_BROKEN = 2

/**
 * The text of whatever was thrown, with each case named.
 *
 * `String(defect)` would be shorter and is what this file had first — falsestart's own
 * `no-raw-coercion` rule rejected it while judging its own source. The objection is the one
 * `cli.ts` already records about `String(warning)`: a coercion that cannot fail is a coercion that
 * hides a wrong value, and `[object Object]` is the least useful thing to print to somebody whose
 * guard just died.
 */
const describeCause = (defect: unknown): string => {
  if (defect instanceof Error) {
    return defect.stack ?? defect.message
  }
  if (typeof defect === 'string') {
    return defect
  }

  // An Error from another realm — a worker, a native module — fails `instanceof` while still
  // carrying the one field worth printing.
  if (typeof defect === 'object' && defect !== null && 'message' in defect && typeof defect.message === 'string') {
    return defect.message
  }

  // Deliberately NOT `JSON.stringify`. The `no-json-global` rule exempts `cli.ts` and `respond.ts`
  // as hook-protocol boundaries, and this is not one — widening an exemption for a convenience is
  // how a scope stops meaning anything. Naming the type is also the more honest answer: a value
  // with no message has nothing to quote, and a serialised blob would suggest otherwise.
  return `a thrown ${typeof defect} carrying no message`
}

/**
 * Which code a defect may exit with, which depends entirely on who reads it.
 *
 * Under Claude Code, 1 is a non-blocking notice. Under Copilot every non-zero exit other than 2
 * denies the tool call, so the only non-blocking code left is 0 — and `docs/reference.md` states the
 * law that a failure falsestart REPORTS must never be able to block a write. A defect exiting 1 in
 * front of Copilot denied every call in the session.
 *
 * `scan` is the exception and earns it: a shell reads 1 as "your code has violations", so a broken
 * gate has to say 2 or it teaches people to reach for `--no-verify`.
 */
const exitCodeFor = (args: readonly string[]): number => {
  if (args[0] === 'scan') {
    return SCAN_BROKEN
  }

  // Both spellings, because `--agent=copilot` is the likeliest typo in the whole flag and refusing
  // it at 1 in front of Copilot is an outage rather than a message.
  const named = args.some(
    (argument, index) =>
      (argument === '--agent' && args[index + 1] !== 'claude-code' && args[index + 1] !== undefined) ||
      (argument.startsWith('--agent=') && argument.slice('--agent='.length) !== 'claude-code'),
  )

  return named ? 0 : 1
}

export const describeDefect = (defect: unknown, args: readonly string[]): { exitCode: number; stderr: string } => ({
  exitCode: exitCodeFor(args),
  stderr:
    `falsestart: internal error — this is a bug in falsestart, not a problem with your rules, your ` +
    `config or your payload. The write was NOT checked — please report it, with the text below.\n` +
    `${describeCause(defect)}\n`,
})
