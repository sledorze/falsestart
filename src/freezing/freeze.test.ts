/**
 * Git's answer becomes a verdict, and no arm of that decision reads the working tree.
 *
 * Every case supplies the bytes git really writes rather than a parsed shape, because the framing
 * is part of what is being decided: `cat-file --batch` reports a ref that does not resolve with
 * `<request> missing` and exit 0, so absence is invisible to everything except the bytes.
 *
 * `describe.each` + `effect` rather than `it.effect.each` wherever both modes apply: the curried
 * form leaves oxlint's vitest plugin unable to resolve the callee, so it reports every case as a
 * test with no assertions.
 */
import { describe, effect, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import type { FreezeInput, FreezeMode, GitAnswer } from './freeze.ts'
import { containedPath, divergence, freeze } from './freeze.ts'

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

/** `<oid> <type> <size>` newline, `<size>` BYTES, newline. Verified against real git output. */
const object = (oid: string, content: string): Uint8Array => {
  const body = encoder.encode(content)
  return bytes(encoder.encode(`${oid} blob ${body.length}\n`), body, encoder.encode('\n'))
}

/** What a request that does not resolve looks like. Exit 0, which is the whole problem. */
const missing = (request: string): Uint8Array => encoder.encode(`${request} missing\n`)

const COMMIT = 'c'.repeat(40)
const commit = (): Uint8Array => {
  const body = encoder.encode('tree 0000\n')
  return bytes(encoder.encode(`${COMMIT} commit ${body.length}\n`), body, encoder.encode('\n'))
}

const answer = (stdout: Uint8Array | string): GitAnswer => ({
  failed: false,
  stderr: '',
  stdout: typeof stdout === 'string' ? encoder.encode(stdout) : stdout,
})

const brokenAnswer = (stderr: string): GitAnswer => ({ failed: true, stderr, stdout: new Uint8Array() })

/** `<mode> <type> <oid>\t<path>` then a NUL, which is what `ls-tree -r -z` writes. */
const tree = (...records: readonly string[]): string => records.map((record) => `${record}${NUL}`).join('')

const CANDIDATES = ['falsestart.config.ts', 'falsestart.config.json'] as const

/** The default probe: the ref resolves and the repository committed no config. */
const probeAnswer = (): GitAnswer => answer(bytes(commit(), ...CANDIDATES.map((name) => missing(`HEAD:${name}`))))

const inputFor = (overrides: Partial<FreezeInput>): FreezeInput => ({
  config: { _tag: 'Candidates', names: CANDIDATES, relative: '' },
  isDocument: (name) => name.endsWith('.yml'),
  listTree: () => answer(''),
  mode: 'auto',
  namedRefs: () => answer(''),
  probe: probeAnswer,
  projectDirectory: '/p',
  repository: { _tag: 'Anchored', anchor: 'verified', toplevel: '/p' },
  readBlobs: () => answer(''),
  ref: 'HEAD',
  refExplicit: false,
  rulesDirectory: './rules',
  rulesPath: { _tag: 'Contained', relative: 'rules' },
  workTree: { _tag: 'Inside' },
  ...overrides,
})

const BOTH_MODES: readonly { readonly mode: FreezeMode }[] = [{ mode: 'auto' }, { mode: 'require' }]

describe('where a path sits relative to a repository', () => {
  // T11
  it('answers by segment rather than by shared prefix', () => {
    expect(containedPath('/p/rules', '/p/rules')).toBe('')
    expect(containedPath('/p', '/p/rules')).toBe('rules')
    expect(containedPath('/p/rules', '/p/rulesx')).toBeUndefined()
    expect(containedPath('/p/rules', '/p/elsewhere')).toBeUndefined()
  })
})

describe('classifying what git said', () => {
  // T12 — the switch cannot live in the thing being frozen, and `off` must not consult git either.
  effect('asks git nothing at all when the freeze is off', () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const outcome = yield* freeze(
        inputFor({
          listTree: () => {
            calls.push('listTree')
            return brokenAnswer('would be Broken')
          },
          mode: 'off',
          namedRefs: () => {
            calls.push('namedRefs')
            return brokenAnswer('would be Broken')
          },
          probe: () => {
            calls.push('probe')
            return brokenAnswer('would be Broken')
          },
          readBlobs: () => {
            calls.push('readBlobs')
            return brokenAnswer('would be Broken')
          },
        }),
      )

      expect(outcome.rules).toEqual({ _tag: 'Unfrozen', reason: '--freeze=off' })
      expect(outcome.config).toEqual({ _tag: 'Unfrozen', reason: '--freeze=off' })
      expect(calls).toEqual([])
    }),
  )

  // T13 — a project that is not a repository is not a broken guard, unless you asked for it to be.
  // `Absent` is a POSITIVE finding — no `.git` directory anywhere up to the filesystem root — and
  // not merely "git declined to answer".
  describe.each(BOTH_MODES)('with --freeze=$mode', ({ mode }) => {
    effect('says there was nothing to freeze where there is no repository at all', () =>
      Effect.gen(function* () {
        const outcome = yield* freeze(inputFor({ mode, workTree: { _tag: 'Absent' } }))

        expect(outcome.rules._tag).toBe(mode === 'require' ? 'Broken' : 'Unfrozen')
        expect(outcome.config._tag).toBe(mode === 'require' ? 'Broken' : 'Unfrozen')
        expect(outcome.rules).toHaveProperty('reason', '/p is not inside a git work tree')
      }),
    )
  })

  // The other half, and the one that was missing: git declining to say which repository this is,
  // while a repository demonstrably exists, is a freeze that could not be completed — not an
  // absence. Reading it as an absence let one file OUTSIDE the repository disarm the guard.
  describe.each(BOTH_MODES)('with --freeze=$mode', ({ mode }) => {
    effect('refuses when git will not say which repository this is', () =>
      Effect.gen(function* () {
        const outcome = yield* freeze(
          inputFor({ mode, workTree: { _tag: 'Unreadable', stderr: 'fatal: bad config line 1 in file /h/.gitconfig' } }),
        )

        expect(outcome.rules._tag).toBe('Broken')
        expect(outcome.config._tag).toBe('Broken')
        expect(outcome.rules).toHaveProperty('reason', expect.stringContaining('bad config line 1'))
      }),
    )
  })

  // T14 — F1. A rules tree outside the project repository is not freezable by the project's ref.
  describe.each(BOTH_MODES)('with --freeze=$mode', ({ mode }) => {
    effect('refuses to claim a rules tree outside the repository is frozen', () =>
      Effect.gen(function* () {
        const outcome = yield* freeze(
          inputFor({ mode, rulesDirectory: '/elsewhere/rules', rulesPath: { _tag: 'Outside' } }),
        )

        expect(outcome.rules._tag).toBe(mode === 'require' ? 'Broken' : 'Unfrozen')
        expect(outcome.rules).toHaveProperty('reason', '/elsewhere/rules is outside the project repository at /p')
      }),
    )
  })

  // T15 — F2. A ref the caller named is a statement that it exists.
  describe.each(BOTH_MODES)('with --freeze=$mode', ({ mode }) => {
    effect('refuses an explicitly named ref that does not resolve', () =>
      Effect.gen(function* () {
        const outcome = yield* freeze(
          inputFor({
            mode,
            probe: () =>
              answer(
                bytes(
                  missing('refs/remotes/origin/main'),
                  ...CANDIDATES.map((name) => missing(`refs/remotes/origin/main:${name}`)),
                ),
              ),
            ref: 'refs/remotes/origin/main',
            refExplicit: true,
          }),
        )

        expect(outcome.rules).toEqual({ _tag: 'Broken', reason: 'refs/remotes/origin/main does not resolve' })
        expect(outcome.config).toEqual({ _tag: 'Broken', reason: 'refs/remotes/origin/main does not resolve' })
      }),
    )
  })

  // T16 — a freshly `git init`ed repository must not start refusing every write.
  describe.each(BOTH_MODES)('with --freeze=$mode', ({ mode }) => {
    effect('treats a repository with no commit as nothing to freeze', () =>
      Effect.gen(function* () {
        const outcome = yield* freeze(
          inputFor({
            mode,
            namedRefs: () => answer(''),
            probe: () => answer(bytes(missing('HEAD'), ...CANDIDATES.map((name) => missing(`HEAD:${name}`)))),
          }),
        )

        expect(outcome.rules._tag).toBe(mode === 'require' ? 'Broken' : 'Unfrozen')
        expect(outcome.rules).toHaveProperty('reason', '/p has no commit yet')
      }),
    )
  })

  // T17 — F2. `git symbolic-ref HEAD refs/heads/nope` touches no file and moves no commit.
  describe.each(BOTH_MODES)('with --freeze=$mode', ({ mode }) => {
    effect('refuses a dangling HEAD in a repository that demonstrably has refs', () =>
      Effect.gen(function* () {
        const outcome = yield* freeze(
          inputFor({
            mode,
            namedRefs: () => answer('refs/heads/master\n'),
            probe: () => answer(bytes(missing('HEAD'), ...CANDIDATES.map((name) => missing(`HEAD:${name}`)))),
          }),
        )

        expect(outcome.rules).toEqual({
          _tag: 'Broken',
          reason: 'HEAD does not resolve in a repository that has refs',
        })
      }),
    )
  })

  // T18 — a broken object store is not a reason to read the working tree instead.
  describe.each(BOTH_MODES)('with --freeze=$mode', ({ mode }) => {
    effect('refuses when the tree listing itself fails', () =>
      Effect.gen(function* () {
        const outcome = yield* freeze(inputFor({ listTree: () => brokenAnswer('fatal: bad object'), mode }))

        expect(outcome.rules._tag).toBe('Broken')
        expect(outcome.rules).toHaveProperty('reason', expect.stringContaining('fatal: bad object'))
      }),
    )
  })

  // T19 — a gitlink is a structure the project committed and a human reviewed. It gets its own
  // reason rather than the misleading "not tracked".
  describe.each(BOTH_MODES)('with --freeze=$mode', ({ mode }) => {
    effect('names a submodule rather than calling it untracked', () =>
      Effect.gen(function* () {
        const outcome = yield* freeze(
          inputFor({ listTree: () => answer(tree(`160000 commit ${'a'.repeat(40)}\trules`)), mode }),
        )

        expect(outcome.rules._tag).toBe(mode === 'require' ? 'Broken' : 'Unfrozen')
        expect(outcome.rules).toHaveProperty(
          'reason',
          './rules is a submodule; its contents are not in HEAD of the project repository',
        )
      }),
    )
  })

  // T20 — the `--preset` shape. An empty listing must never read as a frozen tree of zero rules.
  effect('treats an untracked rules tree as nothing to freeze, not as an empty frozen one', () =>
    Effect.gen(function* () {
      const outcome = yield* freeze(inputFor({}))

      expect(outcome.rules).toEqual({ _tag: 'Unfrozen', reason: './rules is not tracked at HEAD' })
    }),
  )

  // T21 — F5. The working-tree loader follows a symlinked rule document and enforces it, so
  // dropping one would make the freeze weaker than the thing it replaces.
  describe.each(BOTH_MODES)('with --freeze=$mode', ({ mode }) => {
    effect('refuses a rule document committed as a symlink', () =>
      Effect.gen(function* () {
        const outcome = yield* freeze(
          inputFor({
            listTree: () =>
              answer(
                tree(
                  `100644 blob ${'a'.repeat(40)}\trules/real.yml`,
                  `120000 blob ${'b'.repeat(40)}\trules/linked.yml`,
                ),
              ),
            mode,
          }),
        )

        expect(outcome.rules._tag).toBe('Broken')
        expect(outcome.rules).toHaveProperty('reason', expect.stringContaining('rules/linked.yml'))
      }),
    )
  })

  // T22 — and it must not over-fire on a symlink that is not a rule document.
  effect('leaves a committed symlink that is not a rule document alone', () =>
    Effect.gen(function* () {
      const outcome = yield* freeze(
        inputFor({
          listTree: () =>
            answer(
              tree(`100644 blob ${'a'.repeat(40)}\trules/real.yml`, `120000 blob ${'b'.repeat(40)}\trules/README`),
            ),
          readBlobs: () => answer(object('a'.repeat(40), 'id: real\n')),
        }),
      )

      expect(outcome.rules._tag).toBe('Frozen')
      expect(outcome.rules).toHaveProperty('documents', new Map([['real.yml', 'id: real\n']]))
    }),
  )

  // The classifier's own half of the swapped-symlink refusal: `resolveRulesPath` decides that the
  // disk disagrees with the command line, and this is where that becomes a refusal rather than a
  // redirection.
  describe.each(BOTH_MODES)('with --freeze=$mode', ({ mode }) => {
    effect('refuses a rules path that resolves somewhere other than it was named', () =>
      Effect.gen(function* () {
        const outcome = yield* freeze(inputFor({ mode, rulesPath: { _tag: 'Diverged', real: '/p/.weak' } }))

        expect(outcome.rules._tag).toBe('Broken')
        expect(outcome.rules).toHaveProperty('reason', expect.stringContaining('/p/.weak'))
      }),
    )
  })

  // A short blob stream is a read that did not happen, and the frame count is what catches it.
  effect('refuses when the blob stream stops short of the documents it was asked for', () =>
    Effect.gen(function* () {
      const listing = tree(`100644 blob ${'a'.repeat(40)}\trules/a.yml`, `100644 blob ${'b'.repeat(40)}\trules/b.yml`)
      const short = object('a'.repeat(40), 'id: a\n')
      const outcome = yield* freeze(inputFor({ listTree: () => answer(listing), readBlobs: () => answer(short) }))

      expect(outcome.rules._tag).toBe('Broken')
      expect(outcome.rules).toHaveProperty('reason', expect.stringContaining('1 of 2'))
    }),
  )

  // T23 — the crux of the whole change. A freeze that falls back on a git failure is a freeze an
  // agent defeats by breaking git.
  describe.each(BOTH_MODES)('with --freeze=$mode', ({ mode }) => {
    effect('refuses rather than falling back when the blobs cannot be read', () =>
      Effect.gen(function* () {
        const outcome = yield* freeze(
          inputFor({
            listTree: () =>
              answer(tree(`100644 blob ${'a'.repeat(40)}\trules/a.yml`, `100644 blob ${'b'.repeat(40)}\trules/b.yml`)),
            mode,
            readBlobs: () => brokenAnswer('fatal: unable to read object'),
          }),
        )

        expect(outcome.rules._tag).toBe('Broken')
        expect(outcome.rules).toHaveProperty('reason', expect.stringContaining('fatal: unable to read object'))
      }),
    )
  })

  // T24 — a deleted object must not silently shrink the rule set.
  effect('refuses when a blob the listing named is no longer there', () =>
    Effect.gen(function* () {
      const listing = tree(`100644 blob ${'a'.repeat(40)}\trules/a.yml`, `100644 blob ${'b'.repeat(40)}\trules/b.yml`)
      const blobs = bytes(object('a'.repeat(40), 'id: a\n'), missing('b'.repeat(40)))
      const outcome = yield* freeze(inputFor({ listTree: () => answer(listing), readBlobs: () => answer(blobs) }))

      expect(outcome.rules._tag).toBe('Broken')
      expect(outcome.rules).toHaveProperty('reason', expect.stringContaining('b.yml'))
    }),
  )

  // T25 — the keys have to be the shape `readDirectory` produces, or every frozen tree fails to
  // load for a reason that looks nothing like the cause.
  effect('strips the rules prefix so the keys match what the loader expects', () =>
    Effect.gen(function* () {
      const listing = tree(`100644 blob ${'a'.repeat(40)}\trules/a.yml`, `100644 blob ${'b'.repeat(40)}\trules/b/c.yml`)
      const blobs = bytes(object('a'.repeat(40), 'id: a\n'), object('b'.repeat(40), 'id: c\n'))
      const outcome = yield* freeze(inputFor({ listTree: () => answer(listing), readBlobs: () => answer(blobs) }))

      expect(outcome.rules).toEqual({
        _tag: 'Frozen',
        anchor: 'verified',
        documents: new Map([
          ['a.yml', 'id: a\n'],
          ['b/c.yml', 'id: c\n'],
        ]),
        ref: 'HEAD',
      })
    }),
  )

  // T26 — and when the rules directory IS the toplevel there is no prefix to strip.
  effect('leaves the keys alone when the rules directory is the repository root', () =>
    Effect.gen(function* () {
      const outcome = yield* freeze(
        inputFor({
          listTree: () => answer(tree(`100644 blob ${'a'.repeat(40)}\ta.yml`)),
          readBlobs: () => answer(object('a'.repeat(40), 'id: a\n')),
          rulesPath: { _tag: 'Contained', relative: '' },
        }),
      )

      expect(outcome.rules).toHaveProperty('documents', new Map([['a.yml', 'id: a\n']]))
    }),
  )

  // T27 — absence is the answer "the repository committed no such config", not a failure.
  effect('takes the config candidates the ref actually holds', () =>
    Effect.gen(function* () {
      const held = bytes(
        commit(),
        object('1'.repeat(40), 'export default {}\n'),
        missing('HEAD:falsestart.config.mts'),
        object('2'.repeat(40), '{"rules":{}}'),
      )
      const outcome = yield* freeze(
        inputFor({
          config: {
            _tag: 'Candidates',
            names: ['falsestart.config.ts', 'falsestart.config.mts', 'falsestart.config.json'],
            relative: '',
          },
          probe: () => answer(held),
        }),
      )

      expect(outcome.config).toEqual({
        _tag: 'Frozen',
        anchor: 'verified',
        documents: new Map([
          ['falsestart.config.ts', 'export default {}\n'],
          ['falsestart.config.json', '{"rules":{}}'],
        ]),
        ref: 'HEAD',
      })
    }),
  )

  // Not in the design's catalogue, and needed: nothing else reaches the explicit-`--config` arm or a
  // project that is not the repository root, and both are ordinary setups. The requests themselves
  // are asserted, because the path the ref is asked about is the whole of what is being decided.
  effect('asks the ref about the config path --config named', () =>
    Effect.gen(function* () {
      const asked: string[][] = []
      const held = bytes(commit(), object('1'.repeat(40), '{"rules":{}}'))
      const outcome = yield* freeze(
        inputFor({
          config: { _tag: 'Explicit', name: 'scope.json', origin: '/p/tools/scope.json', relative: 'tools/scope.json' },
          probe: (requests) => {
            asked.push([...requests])
            return answer(held)
          },
        }),
      )

      expect(asked).toEqual([['HEAD', 'HEAD:tools/scope.json']])
      expect(outcome.config).toHaveProperty('documents', new Map([['scope.json', '{"rules":{}}']]))
    }),
  )

  effect('asks the ref about candidates under the project, not under the repository root', () =>
    Effect.gen(function* () {
      const asked: string[][] = []
      yield* freeze(
        inputFor({
          config: { _tag: 'Candidates', names: ['falsestart.config.json'], relative: 'packages/app' },
          probe: (requests) => {
            asked.push([...requests])
            return answer(bytes(commit(), missing('HEAD:packages/app/falsestart.config.json')))
          },
        }),
      )

      expect(asked).toEqual([['HEAD', 'HEAD:packages/app/falsestart.config.json']])
    }),
  )

  // Not in the design's catalogue, and the hole it closes is real: `respond` looks the explicit
  // config up in the frozen map, so an absent entry would send it to the file on disk — and creating
  // the file the command line names is a write an agent can make.
  describe.each(BOTH_MODES)('with --freeze=$mode', ({ mode }) => {
    effect('refuses a --config path the ref does not hold', () =>
      Effect.gen(function* () {
        const outcome = yield* freeze(
          inputFor({
            config: { _tag: 'Explicit', name: 'scope.json', origin: '/p/scope.json', relative: 'scope.json' },
            mode,
            probe: () => answer(bytes(commit(), missing('HEAD:scope.json'))),
          }),
        )

        expect(outcome.config).toEqual({ _tag: 'Broken', reason: '/p/scope.json is not committed at HEAD' })
      }),
    )
  })

  // T28 — a config outside the repository cannot be claimed frozen by the repository's ref.
  describe.each(BOTH_MODES)('with --freeze=$mode', ({ mode }) => {
    effect('refuses to claim a config outside the repository is frozen', () =>
      Effect.gen(function* () {
        const outcome = yield* freeze(
          inputFor({
            config: { _tag: 'Explicit', name: 'scope.json', origin: '/elsewhere/scope.json', relative: undefined },
            mode,
            probe: () => answer(commit()),
          }),
        )

        expect(outcome.config._tag).toBe(mode === 'require' ? 'Broken' : 'Unfrozen')
        expect(outcome.config).toHaveProperty('reason', '/elsewhere/scope.json is outside the project repository')
      }),
    )
  })

  // T29 — a short read of the probe is not a smaller config; it is a read that did not happen.
  describe.each(BOTH_MODES)('with --freeze=$mode', ({ mode }) => {
    effect('refuses a truncated probe rather than reading what arrived', () =>
      Effect.gen(function* () {
        const whole = bytes(commit(), ...CANDIDATES.map((name) => missing(`HEAD:${name}`)))
        const outcome = yield* freeze(inputFor({ mode, probe: () => answer(whole.slice(0, -10)) }))

        expect(outcome.config._tag).toBe('Broken')
        expect(outcome.rules._tag).toBe('Broken')
      }),
    )
  })

  // T89 — a rules directory legitimately committed as a symlink is not "not tracked", and the
  // freeze does not follow it: it freezes the path the command line named.
  describe.each(BOTH_MODES)('with --freeze=$mode', ({ mode }) => {
    effect('names a rules directory that the ref holds as a symlink', () =>
      Effect.gen(function* () {
        const outcome = yield* freeze(
          inputFor({ listTree: () => answer(tree(`120000 blob ${'a'.repeat(40)}\trules`)), mode }),
        )

        expect(outcome.rules._tag).toBe(mode === 'require' ? 'Broken' : 'Unfrozen')
        expect(outcome.rules).toHaveProperty(
          'reason',
          './rules is committed as a symlink; falsestart freezes the path the command line named, not where it points',
        )
      }),
    )
  })
})

describe('an anchor that one write can repoint', () => {
  const frozenTree = (overrides: Partial<FreezeInput>) =>
    inputFor({
      listTree: () => answer(tree(`100644 blob ${'a'.repeat(40)}\trules/a.yml`)),
      readBlobs: () => answer(object('a'.repeat(40), 'id: a\n')),
      ...overrides,
    })

  // T75 — E4. A linked worktree is a supported git workflow, so `auto` reports rather than refuses,
  // and it must freeze exactly as much as it would anywhere else.
  effect('freezes an unverified anchor under auto, with the same documents', () =>
    Effect.gen(function* () {
      const unverified = yield* freeze(frozenTree({ repository: { _tag: 'Anchored', anchor: 'unverified', toplevel: '/p' } }))
      const verified = yield* freeze(frozenTree({ repository: { _tag: 'Anchored', anchor: 'verified', toplevel: '/p' } }))

      expect(unverified.rules._tag).toBe('Frozen')
      expect(unverified.rules).toHaveProperty('anchor', 'unverified')
      expect(unverified.rules).toHaveProperty('documents', new Map([['a.yml', 'id: a\n']]))
      expect(unverified.rules).toEqual({ ...verified.rules, anchor: 'unverified' })
    }),
  )

  // T76 — and `require` is the mode with something to say about the one thing here that genuinely
  // cannot be verified.
  effect('refuses an unverified anchor under require, saying what the condition is', () =>
    Effect.gen(function* () {
      const outcome = yield* freeze(frozenTree({ mode: 'require', repository: { _tag: 'Anchored', anchor: 'unverified', toplevel: '/p' } }))

      expect(outcome.rules._tag).toBe('Broken')
      expect(outcome.config._tag).toBe('Broken')
      const reason = outcome.rules._tag === 'Broken' ? outcome.rules.reason : ''
      expect(reason).toContain('/p/.git is not a directory')
      expect(reason).toContain('linked worktree outside its main repository')
      expect(reason).toContain('--separate-git-dir')
      expect(reason).toContain('--freeze=auto')
    }),
  )

  // T77 — reported on the outcome, so `--doctor` can print the line only where it means something.
  effect('carries a verified anchor through to the outcome', () =>
    Effect.gen(function* () {
      const outcome = yield* freeze(frozenTree({}))

      expect(outcome.rules).toHaveProperty('anchor', 'verified')
      expect(outcome.config).toHaveProperty('anchor', 'verified')
    }),
  )
})

describe('what the working tree has that the ref does not', () => {
  // T30 — the whole answer to "I edited a rule and nothing happened".
  it('reports what was added, changed and removed, sorted by path', () => {
    const frozen = new Map([
      ['a.yml', 'one'],
      ['b.yml', 'two'],
      ['gone.yml', 'three'],
    ])
    const working = new Map([
      ['a.yml', 'one'],
      ['b.yml', 'CHANGED'],
      ['new.yml', 'four'],
    ])

    expect(divergence(frozen, working)).toEqual([
      { kind: 'changed', path: 'b.yml' },
      { kind: 'removed', path: 'gone.yml' },
      { kind: 'added', path: 'new.yml' },
    ])
  })

  it('reports nothing when the two agree', () => {
    expect(divergence(new Map([['a.yml', 'one']]), new Map([['a.yml', 'one']]))).toEqual([])
  })
})
