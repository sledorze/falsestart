/**
 * What a write failure means when the reader went away.
 *
 * A consumer that stops reading is not a failure of the command that was writing to it.
 * `--list-rules | head -1` and `--list-rules | grep -q <id>` both close the pipe the moment they
 * have what they came for, and the write that lands after that fails with `EPIPE`. Propagated, it
 * exits 1 — which in this binary's documented vocabulary means the command line was REFUSED, with
 * nothing on stderr to say otherwise. It only happens once the document outgrows a pipe buffer
 * (about 700 rules with the shipped shape), so it presents as flakiness rather than as a rule.
 *
 * Classified on the OS's own errno rather than on the message text: the message is prose that a
 * platform release can reword, and this decides whether a document that never landed is reported
 * as a success. Everything else stays a failure — a full disk on `> rules.json` must not be read
 * as "the reader had enough".
 *
 * It lives here rather than in `cli.ts` for the reason `scanning/baseline.ts` gives about itself:
 * that file is excluded from both the coverage ratchet and mutation testing, and a predicate whose
 * FALSE direction is the dangerous one has no business being written where nothing can exercise it.
 */

/** The failure carries the platform's own error as its `cause`; the errno is on that. */
const causeOf = (value: unknown): unknown =>
  typeof value === 'object' && value !== null && 'cause' in value ? value.cause : undefined

export const isBrokenPipe = (failure: unknown): boolean => {
  const cause = causeOf(failure)

  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'EPIPE'
}
