/**
 * falsestart's library surface.
 *
 * A re-export of each area's entry point, never of an area's internals — so this file, and any
 * documentation citing it, changes when what falsestart OFFERS changes rather than when an
 * implementation detail moves.
 *
 * The areas and the rule separating them are described once, in `docs/architecture.md`. They are
 * not restated here: a taxonomy asserted in three places is a taxonomy that will disagree with
 * itself.
 */
export * from './checking/index.ts'
export * from './config/index.ts'
export * from './hook/index.ts'
export * from './testing/index.ts'
