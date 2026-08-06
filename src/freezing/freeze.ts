/**
 * What a git ref committed, and what that licenses.
 *
 * Stub. Slice 0 needs `Anchor` and `containedPath` to exist; the classifiers arrive in slice 1.
 */

export type Anchor = 'unverified' | 'verified'

/** A path's location relative to a repository toplevel, or `undefined` when it is outside. */
export const containedPath = (toplevelReal: string, targetReal: string): string | undefined => {
  if (toplevelReal === targetReal) {
    return ''
  }
  const prefix = `${toplevelReal}/`
  return targetReal.startsWith(prefix) ? targetReal.slice(prefix.length) : undefined
}
