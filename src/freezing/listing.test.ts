/**
 * git's own output formats, pinned against the bytes git writes.
 *
 * Both parsers have a failure mode that a plausible implementation walks straight into and no
 * assertion about a happy path can see: dropping a non-regular tree entry makes a rule the working
 * tree enforces vanish from the freeze that replaces it, and reading `cat-file` frames by scanning
 * for a line shape lets one rule's prose refuse every write in the repository.
 */
import { describe, effect, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { parseBatchObjects, parseTreeListing } from './listing.ts'

const encoder = new TextEncoder()

/** Named rather than written literally: a NUL in source is invisible in every diff and review. */
const NUL = '\u0000'

const bytes = (...parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const joined = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  return joined
}

const tree = (...records: readonly string[]): string => records.map((record) => `${record}${NUL}`).join('')

/** `<oid> <type> <size>` newline, `<size>` BYTES, newline. */
const object = (oid: string, content: string): Uint8Array => {
  const body = encoder.encode(content)
  return bytes(encoder.encode(`${oid} blob ${body.length}\n`), body, encoder.encode('\n'))
}

const missing = (request: string): Uint8Array => encoder.encode(`${request} missing\n`)

describe('the tree a ref carries', () => {
  // T1 — nothing is dropped here. A `120000` at a rule document's path is a policy question, and
  // filtering it out at this level answers that question silently and wrongly.
  it('keeps every mode, including symlinks and gitlinks', () => {
    const listing = tree(
      `100644 blob ${'a'.repeat(40)}\trules/a.yml`,
      `100755 blob ${'b'.repeat(40)}\trules/run.sh`,
      `120000 blob ${'c'.repeat(40)}\trules/linked.yml`,
      `160000 commit ${'d'.repeat(40)}\trules/vendor`,
    )

    expect(parseTreeListing(listing)).toEqual([
      { mode: '100644', oid: 'a'.repeat(40), path: 'rules/a.yml', type: 'blob' },
      { mode: '100755', oid: 'b'.repeat(40), path: 'rules/run.sh', type: 'blob' },
      { mode: '120000', oid: 'c'.repeat(40), path: 'rules/linked.yml', type: 'blob' },
      { mode: '160000', oid: 'd'.repeat(40), path: 'rules/vendor', type: 'commit' },
    ])
  })

  // T2 — the shape a gitignored `node_modules` produces: exit 0, and nothing at all.
  it('answers nothing for an empty listing', () => {
    expect(parseTreeListing('')).toEqual([])
  })

  // T3 — `-z` does not quote a path, so only the FIRST tab separates the metadata from it.
  it('carries a path containing a space and a path containing a tab through intact', () => {
    const listing = tree(
      `100644 blob ${'a'.repeat(40)}\trules/with space.yml`,
      `100644 blob ${'b'.repeat(40)}\trules/with\ttab.yml`,
    )

    expect(parseTreeListing(listing).map((entry) => entry.path)).toEqual([
      'rules/with space.yml',
      'rules/with\ttab.yml',
    ])
  })

  // T4 — the only fixture that reaches the guard.
  it('drops a record that carries no oid', () => {
    expect(parseTreeListing(tree(`100644 blob\trules/a.yml`))).toEqual([])
  })
})

describe('the objects a ref holds', () => {
  // T5 — framing is by declared size, so a newline inside a blob is content and nothing else.
  effect('returns contents in request order when a blob contains a newline', () =>
    Effect.gen(function* () {
      const stdout = bytes(object('a'.repeat(40), 'id: a\nlanguage: tsx\n'), object('b'.repeat(40), 'id: b\n'))

      expect(yield* parseBatchObjects(stdout, ['a'.repeat(40), 'b'.repeat(40)])).toEqual([
        'id: a\nlanguage: tsx\n',
        'id: b\n',
      ])
    }),
  )

  // T6 — the header's size is a BYTE count. Every shipped rule message has a typographic quote and
  // several have an em dash, so decoding before slicing corrupts nearly the whole corpus.
  effect('returns a blob with a multi-byte character intact', () =>
    Effect.gen(function* () {
      const stdout = object('a'.repeat(40), 'id: café — naïve\n')

      expect(yield* parseBatchObjects(stdout, ['a'.repeat(40)])).toEqual(['id: café — naïve\n'])
    }),
  )

  // T7 — only the header AT A FRAME BOUNDARY is inspected. A scanner would refuse the whole tree
  // because of one rule's prose, and the prose here is prose someone would really write.
  effect('never mistakes a blob’s own prose for git’s framing', () =>
    Effect.gen(function* () {
      const first = 'note: |\n  the object deadbeef missing\n'
      const second = "message: 'the file is missing'"
      const stdout = bytes(object('a'.repeat(40), first), object('b'.repeat(40), second))

      expect(yield* parseBatchObjects(stdout, ['a'.repeat(40), 'b'.repeat(40)])).toEqual([first, second])
    }),
  )

  // T8 — `<request> missing` comes with exit 0, so absence has to be a value rather than a gap.
  effect('reports a request the ref does not hold as absent, in place', () =>
    Effect.gen(function* () {
      const stdout = bytes(object('a'.repeat(40), 'id: a\n'), missing('HEAD:falsestart.config.ts'), object('c'.repeat(40), 'id: c\n'))

      expect(yield* parseBatchObjects(stdout, ['a', 'HEAD:falsestart.config.ts', 'c'])).toEqual([
        'id: a\n',
        { _tag: 'Absent' },
        'id: c\n',
      ])
    }),
  )

  // T9 — a short read is a read that did not happen, not a smaller rule set.
  effect('fails when the stream stops inside a declared size', () =>
    Effect.gen(function* () {
      const whole = bytes(object('a'.repeat(40), 'id: a\n'), object('b'.repeat(40), 'id: b-with-more-content\n'))
      const truncated = whole.slice(0, whole.length - 10)

      const reason = yield* Effect.flip(parseBatchObjects(truncated, ['a'.repeat(40), 'b'.repeat(40)]))

      expect(reason).toContain('declared')
    }),
  )

  // T10 — the same failure through a different shape.
  effect('fails when git answered fewer frames than were requested', () =>
    Effect.gen(function* () {
      const reason = yield* Effect.flip(parseBatchObjects(object('a'.repeat(40), 'id: a\n'), ['a', 'b']))

      expect(reason).toContain('1 of 2')
    }),
  )

  // Not in the design's catalogue: `indexOf` answers -1 when the stream stops before a header's
  // newline, and that arm has to lead somewhere other than a silently shorter list.
  effect('fails when the stream stops part-way through a header', () =>
    Effect.gen(function* () {
      const reason = yield* Effect.flip(parseBatchObjects(encoder.encode(`${'a'.repeat(40)} blob 6`), ['a']))

      expect(reason).toContain('mid-header')
    }),
  )
})
