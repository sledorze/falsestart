/**
 * Every API a rule message tells you to use must actually exist.
 *
 * A rule that blocks your code and then names a remedy that does not compile is worse than one
 * that says nothing: it costs the reader a round trip to discover the advice was wrong. This is
 * exactly the kind of claim that rots silently — the messages are prose, nothing type-checks them,
 * and an Effect release that renames a combinator would leave them confidently wrong.
 *
 * Four messages were already wrong when this was written (`Effect.async`, `Effect.catchAll`,
 * `Config.integer`, `Schema.decodeUnknown` — none of which exist in Effect 4), which is why the
 * check exists rather than a promise to be careful.
 */
import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { expect, layer } from '@effect/vitest'
import { Config, Context, Data, Effect, Layer, Schema } from 'effect'
import { TestClock, TestConsole } from 'effect/testing'
// `HttpClient` and `HttpClientRequest` live in a subpath the root import does not re-export, so a
// message naming them was previously unverifiable — the regex below simply did not look for them.
import { HttpClient, HttpClientRequest } from 'effect/unstable/http'
import { loadRules } from './checking/loader.ts'

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

/** The namespaces a rule message is allowed to name, and what each actually exports. */
const NAMESPACES: Readonly<Record<string, object>> = {
  Config,
  Context,
  Data,
  Effect,
  HttpClient,
  HttpClientRequest,
  Layer,
  Schema,
  TestClock,
  TestConsole,
}

/** `Effect.tryPromise`, `Schema.NumberFromString`, … as they appear in prose. */
const REFERENCE =
  /\b(Config|Context|Data|Effect|HttpClient|HttpClientRequest|Layer|Schema|TestClock|TestConsole)\.([A-Za-z][\dA-Za-z]*)/g

/**
 * Names that are deliberately not a member lookup: `NodeRuntime.runMain` lives in a platform
 * package, and prose sometimes says "Effect Config" or "Effect Schema" as a proper noun.
 */
const NOT_A_MEMBER = new Set([
  'Effect.Config',
  'Effect.Schema',
  'Effect.Layer',
  // TYPE names, which is the whole subject of `no-effect-assertion`: its message and note have to
  // spell the thing being asserted into. `typeof Effect.Effect` is `undefined` at runtime — checked
  // — so a member lookup is the wrong question to ask about them, exactly as for the three above.
  'Effect.Effect',
  'Layer.Layer',
])

const referencesIn = (text: string): readonly string[] => [...text.matchAll(REFERENCE)].map((match) => match[0])

layer(platform)('rule messages', (it) => {
  it.effect('only name Effect APIs that exist', () =>
    Effect.gen(function* () {
      const rules = yield* loadRules('rules')

      const missing: string[] = []
      for (const rule of rules) {
        const prose = `${rule.message ?? ''}\n${rule.note ?? ''}`

        for (const reference of referencesIn(prose)) {
          if (NOT_A_MEMBER.has(reference)) {
            continue
          }
          const [namespace, member] = reference.split('.')
          const exports = NAMESPACES[namespace ?? '']
          if (exports !== undefined && !(String(member) in exports)) {
            missing.push(`${rule.id}: ${reference}`)
          }
        }
      }

      expect(missing).toEqual([])
    }),
  )

  it.effect('name at least one concrete remedy in every Effect rule', () =>
    Effect.gen(function* () {
      // `rules/effect/` exists to give Effect-specific advice. A message there that names no API
      // is advice the reader still has to go and look up, which is most of the work.
      const rules = yield* loadRules('rules/effect')

      const vague = rules
        .filter((rule) => referencesIn(`${rule.message ?? ''}\n${rule.note ?? ''}`).length === 0)
        .map((rule) => rule.id)

      expect(vague).toEqual([])
    }),
  )
})
