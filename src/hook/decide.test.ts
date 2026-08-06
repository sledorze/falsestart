import { describe, effect, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import type { Rule } from '../checking/rule.ts'
import { parseRule } from '../checking/rule.ts'
import type { Decision } from './decide.ts'
import { decide, judgesPayload } from './decide.ts'

const rulesOf = (...sources: readonly string[]) => Effect.all(sources.map((source) => parseRule(source, 'test.yml')))

const noAsAny = `
id: no-as-any
language: tsx
message: 'as any erases the type'
rule:
  pattern: $X as any
`

const writePayload = (content: string, path = '/repo/src/widget.ts') => ({
  tool_input: { content, file_path: path },
  tool_name: 'Write',
})

describe('hook decision', () => {
  effect('denies a Write whose content violates a rule', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), writePayload('const x = value as any'))

      expect(decision._tag).toBe('Deny')
      expect(decision._tag === 'Deny' && decision.reason).toContain('as any erases the type')
    }),
  )

  effect('names the rule and the line in the denial', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), writePayload('const ok = 1\nconst x = y as any'))

      const reason = decision._tag === 'Deny' ? decision.reason : ''
      expect(reason).toContain('no-as-any')
      expect(reason).toContain('2')
    }),
  )

  effect('defers a Write whose content is clean', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), writePayload('const x = value as Widget'))

      expect(decision._tag).toBe('Defer')
    }),
  )

  effect('judges an Edit by the text it would introduce', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), {
        tool_input: {
          file_path: '/repo/src/widget.ts',
          new_string: 'const x = value as any',
          old_string: 'const x = value',
        },
        tool_name: 'Edit',
      })

      expect(decision._tag).toBe('Deny')
    }),
  )

  effect('has no opinion about tools that do not write source', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), {
        tool_input: { command: 'const x = value as any' },
        tool_name: 'Bash',
      })

      expect(decision._tag).toBe('Defer')
    }),
  )

  effect('respects the rule file scope, so an out-of-scope path is not blocked', () =>
    Effect.gen(function* () {
      const scoped = yield* rulesOf(`${noAsAny}files:\n  - '**/*.tsx'\n`)

      const decision = yield* decide(scoped, writePayload('const x = value as any', '/repo/src/widget.ts'))

      expect(decision._tag).toBe('Defer')
    }),
  )

  effect('lists every violation rather than only the first', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), writePayload('const a = x as any\nconst b = y as any'))

      const reason = decision._tag === 'Deny' ? decision.reason : ''
      expect(reason.match(/no-as-any/g)).toHaveLength(2)
    }),
  )

  effect('advises rather than blocks on a finding below error severity', () =>
    Effect.gen(function* () {
      const advisory = yield* rulesOf(`${noAsAny}severity: warning\n`)

      const decision = yield* decide(advisory, writePayload('const x = value as any'))

      // Not Deny — it must not stop the write. Not Defer either: dropping it would make a
      // `warning` rule do nothing at all.
      expect(decision._tag).toBe('Advise')
      expect(decision._tag === 'Advise' && decision.note).toContain('as any erases the type')
    }),
  )

  effect('prefers blocking over advising when both kinds are found', () =>
    Effect.gen(function* () {
      const mixed = yield* rulesOf(noAsAny, `${noAsAny.replace('no-as-any', 'soft-rule')}severity: warning\n`)

      const decision = yield* decide(mixed, writePayload('const x = value as any'))

      expect(decision._tag).toBe('Deny')
    }),
  )

  effect('reports rather than blocks when the payload makes no sense', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), 'not a payload at all')

      expect(decision._tag).toBe('Report')
    }),
  )

  effect('reports a payload that names no tool', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), { tool_input: { content: 'x' } })

      expect(decision._tag).toBe('Report')
    }),
  )

  effect('reports a write tool whose input is not an object', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), { tool_input: 'nonsense', tool_name: 'Write' })

      expect(decision._tag).toBe('Report')
    }),
  )

  effect('reports a Write that carries no path to judge', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), {
        tool_input: { content: 'const x = value as any' },
        tool_name: 'Write',
      })

      expect(decision._tag).toBe('Report')
    }),
  )

  effect('reports, and does not block, when a rule itself cannot run', () =>
    Effect.gen(function* () {
      const broken: Rule = { id: 'broken', language: 'tsx', rule: { nonsense: true } }

      const decision = yield* decide([broken], writePayload('const x = 1'))

      expect(decision._tag).toBe('Report')
      expect(decision._tag === 'Report' && decision.problem).toContain('broken')
    }),
  )
})

describe('project-relative scoping', () => {
  effect('applies a repo-relative rule glob to the absolute path a hook reports', () =>
    Effect.gen(function* () {
      // Regression: rules are authored as `src/**/*.ts`, hooks report `/repo/src/a.ts`, and
      // matching one against the other used to silently never fire.
      const scoped = yield* rulesOf(`${noAsAny}files:\n  - 'src/**/*.ts'\n`)

      const decision = yield* decide(scoped, {
        cwd: '/repo',
        tool_input: { content: 'const x = value as any', file_path: '/repo/src/widget.ts' },
        tool_name: 'Write',
      })

      expect(decision._tag).toBe('Deny')
    }),
  )

  effect('still keeps a repo-relative rule off a path it does not cover', () =>
    Effect.gen(function* () {
      const scoped = yield* rulesOf(`${noAsAny}files:\n  - 'src/**/*.ts'\n`)

      const decision = yield* decide(scoped, {
        cwd: '/repo',
        tool_input: { content: 'const x = value as any', file_path: '/repo/vendor/widget.ts' },
        tool_name: 'Write',
      })

      expect(decision._tag).toBe('Defer')
    }),
  )

  effect('falls back to the absolute path when the payload carries no cwd', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), writePayload('const x = value as any'))

      expect(decision._tag).toBe('Deny')
    }),
  )
})

// A judged write that no rule is scoped to is indistinguishable, from the outside, from a write
// every rule examined and approved. Both are silence. A repo that wires up the hook and writes
// only `.js` gets a guard that is installed, registered, healthy, and inert — which is how this
// came in: a probe carrying a hardcoded credential and a swallowed catch went through untouched,
// and the report was "falsestart does not block", not "falsestart does not cover .js".
//
// Opt-in, because the honest version of this signal is noisy. Measured against the shipped
// presets: it fires on every `.md`, `.json`, `.yml` and `.js` write under all three, and on test
// files under `clean-code` only — `all` and `effect` carry three rules that judge test files, so
// those stay quiet. Default-on would train the reader to ignore it, which is worse than saying
// nothing, because an ignored warning still looks like coverage.
describe('unscoped writes', () => {
  const scopedToTypeScript = `${noAsAny}files:\n  - '**/*.ts'\n`

  const inRepo = (path: string, content = 'const x = value as any') => ({
    cwd: '/repo',
    tool_input: { content, file_path: path },
    tool_name: 'Write',
  })

  effect('advises when asked and no rule is scoped to the path', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(scopedToTypeScript), inRepo('/repo/src/widget.js'), {
        warnUnscoped: true,
      })

      expect(decision._tag).toBe('Advise')
      // The path is the whole point: "something was unguarded" without saying what is not
      // actionable, and the reader cannot tell which of their globs is wrong.
      expect(decision._tag === 'Advise' && decision.note).toContain('src/widget.js')
    }),
  )

  effect('stays silent about the same write when not asked', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(scopedToTypeScript), inRepo('/repo/src/widget.js'))

      expect(decision._tag).toBe('Defer')
    }),
  )

  // The negative that matters. "No rule applies" and "every rule applied and found nothing" are
  // the two silences this is meant to tell apart; conflating them would make the warning fire on
  // every clean write in the repo, which is every write.
  effect('says nothing when a rule does apply and finds nothing', () =>
    Effect.gen(function* () {
      const decision = yield* decide(
        yield* rulesOf(scopedToTypeScript),
        inRepo('/repo/src/widget.ts', 'const x = value as Widget'),
        { warnUnscoped: true },
      )

      expect(decision._tag).toBe('Defer')
    }),
  )

  effect('does not warn about a tool it was never going to judge', () =>
    Effect.gen(function* () {
      const decision = yield* decide(
        yield* rulesOf(scopedToTypeScript),
        { tool_input: {}, tool_name: 'Bash' },
        {
          warnUnscoped: true,
        },
      )

      expect(decision._tag).toBe('Defer')
    }),
  )

  effect('never turns a denial into advice', () =>
    Effect.gen(function* () {
      // Advising is a non-blocking outcome. If the warning ever pre-empted a real finding it would
      // convert a block into a pass — the tool failing at the one thing it exists to do.
      const decision = yield* decide(yield* rulesOf(scopedToTypeScript), inRepo('/repo/src/widget.ts'), {
        warnUnscoped: true,
      })

      expect(decision._tag).toBe('Deny')
    }),
  )

  effect('reports an empty rule set on every judged write, which is the honest answer', () =>
    Effect.gen(function* () {
      // Loading zero rules is the most complete version of "guarding nothing", and the one most
      // likely to be believed healthy — `--doctor` says `0 loaded`, but nobody runs it twice.
      const decision = yield* decide([], inRepo('/repo/src/widget.ts'), { warnUnscoped: true })

      expect(decision._tag).toBe('Advise')
    }),
  )
})

describe('notebook writes', () => {
  effect('judges a NotebookEdit by the source it would introduce', () =>
    Effect.gen(function* () {
      // NotebookEdit writes real source and was previously an unjudged bypass.
      const decision = yield* decide(yield* rulesOf(noAsAny), {
        tool_input: {
          cell_type: 'code',
          new_source: 'const x = value as any',
          notebook_path: '/repo/analysis.ipynb',
        },
        tool_name: 'NotebookEdit',
      })

      expect(decision._tag).toBe('Deny')
    }),
  )

  effect('scopes a notebook by its own path field', () =>
    Effect.gen(function* () {
      // The path lives in `notebook_path`, not `file_path`; reading the wrong key would leave the
      // rule unscoped rather than out of scope.
      const scoped = yield* rulesOf(`${noAsAny}files:\n  - '**/*.ts'\n`)

      const decision = yield* decide(scoped, {
        tool_input: { new_source: 'const x = value as any', notebook_path: '/repo/analysis.ipynb' },
        tool_name: 'NotebookEdit',
      })

      expect(decision._tag).toBe('Defer')
    }),
  )

  effect('reports a NotebookEdit missing its path', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), {
        tool_input: { new_source: 'const x = value as any' },
        tool_name: 'NotebookEdit',
      })

      expect(decision._tag).toBe('Report')
    }),
  )

  // `judgesPayload` had no direct test — it was only ever exercised through `respond`, which always
  // hands it a well-formed object. Mutation testing found every conjunct of its record guard
  // survivable: nothing fed it `null`, an array, or a non-object, so `typeof value === 'object'`,
  // `value !== null` and `!Array.isArray(value)` could each be deleted with the suite still green.
  // Line coverage was 100% throughout.
  describe('payload triage', () => {
    it('treats a malformed payload as a candidate rather than skipping it', () => {
      // True means "this is mine to judge", and `decide` then reports the problem. Skipping here
      // would silently swallow exactly the case worth reporting, per the function's own docstring.
      expect(judgesPayload(null)).toBeTruthy()
      expect(judgesPayload([{ tool_name: 'Write' }])).toBeTruthy()
      expect(judgesPayload('Write')).toBeTruthy()
      expect(judgesPayload(undefined)).toBeTruthy()
    })

    it('claims a record whose tool_name is absent or not a string, for the same reason', () => {
      expect(judgesPayload({})).toBeTruthy()
      expect(judgesPayload({ tool_name: 7 })).toBeTruthy()
    })

    it('passes on a well-formed call to a tool it does not judge', () => {
      expect(judgesPayload({ tool_name: 'Bash' })).toBeFalsy()
      expect(judgesPayload({ tool_name: 'Write' })).toBeTruthy()
      expect(judgesPayload({ tool_name: 'Edit' })).toBeTruthy()
      expect(judgesPayload({ tool_name: 'NotebookEdit' })).toBeTruthy()
    })
  })
})

/**
 * GitHub Copilot CLI, whose payload is a second wire contract rather than a variant of the first.
 *
 * The agent is DECLARED, never sniffed: a payload says what shape came in and nothing whatsoever
 * about how the runtime will read the answer, and that second half is where a wrong guess turns a
 * deny into an allow. What IS read from the payload is which of the two spellings GitHub documents
 * for its OWN envelope arrived — a choice the hook author makes in the hook config file, by the
 * casing of the event name, and one that can change without the agent changing.
 */
describe('the Copilot payload contract', () => {
  // T-A1 — triage recognises both Copilot spellings, defers Copilot's non-write traffic, and claims
  // a misdeclaration so `decide` can report it rather than deferring in silence.
  it('claims a Copilot write in either spelling and lets its other traffic past', () => {
    expect(judgesPayload({ toolName: 'bash' }, 'copilot')).toBeFalsy()
    // The hot path in the VS Code compatible spelling. Without the second envelope declared this is
    // `true`, and `respond` then loads the whole rule tree and spawns the freeze's four git
    // processes for a `bash` call — on every single tool call in the session.
    expect(judgesPayload({ tool_name: 'bash' }, 'copilot')).toBeFalsy()
    expect(judgesPayload({ toolName: 'edit' }, 'copilot')).toBeTruthy()
    expect(judgesPayload({ tool_name: 'edit' }, 'copilot')).toBeTruthy()
    expect(judgesPayload({ toolName: 'create' }, 'copilot')).toBeTruthy()
    // A tool from ANOTHER contract is claimed rather than deferred, which is what lets `decide`
    // report that the flag names the wrong runtime. Deferring here is silence, and silence is the
    // one answer a guard must never give to a payload it cannot judge.
    expect(judgesPayload({ tool_name: 'Write' }, 'copilot')).toBeTruthy()
    expect(judgesPayload({ toolName: 'edit' })).toBeTruthy()
    expect(judgesPayload({ tool_name: 'Bash' })).toBeFalsy()
  })

  const problemOf = (decision: Decision): string => (decision._tag === 'Report' ? decision.problem : '')

  // T-A2
  effect('judges a Copilot edit by the text it would introduce, in the camelCase envelope', () =>
    Effect.gen(function* () {
      const decision = yield* decide(
        yield* rulesOf(noAsAny),
        {
          cwd: '/repo',
          toolArgs: {
            new_str: 'const x = value as any',
            old_str: 'const x = value',
            path: '/repo/src/widget.ts',
          },
          toolName: 'edit',
        },
        { agent: 'copilot' },
      )

      expect(decision._tag).toBe('Deny')
    }),
  )

  // T-A2b — the same write in the VS Code compatible envelope, which a repo migrating a
  // `.claude/settings.json` registration gets by naming the event `PreToolUse`.
  effect('judges the same edit in the VS Code compatible envelope', () =>
    Effect.gen(function* () {
      const decision = yield* decide(
        yield* rulesOf(noAsAny),
        {
          cwd: '/repo',
          tool_input: {
            new_str: 'const x = value as any',
            old_str: 'const x = value',
            path: '/repo/src/widget.ts',
          },
          tool_name: 'edit',
        },
        { agent: 'copilot' },
      )

      expect(decision._tag).toBe('Deny')
    }),
  )

  // T-A3a — observed on a real invocation (github/copilot-cli#3349), so it is the shape to expect
  // rather than an edge case.
  effect('decodes toolArgs delivered as a JSON-encoded string', () =>
    Effect.gen(function* () {
      const decision = yield* decide(
        yield* rulesOf(noAsAny),
        {
          cwd: '/repo',
          toolArgs: '{"new_str":"const x = value as any","old_str":"","path":"/repo/src/widget.ts"}',
          toolName: 'edit',
        },
        { agent: 'copilot' },
      )

      expect(decision._tag).toBe('Deny')
    }),
  )

  // T-A3b — the negative that keeps the decode inside the contract that documents it. Claude Code
  // never sends a string here, so reinterpreting one would accept a shape its contract does not
  // have. Cannot be seen failing by withholding code; guarded by dropping the `encodedInput`
  // conjunct and watching it turn into a Deny.
  effect('never reinterprets a string tool_input under the default contract', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), {
        tool_input: '{"content":"const x = value as any","file_path":"/repo/src/widget.ts"}',
        tool_name: 'Write',
      })

      expect(decision._tag).toBe('Report')
    }),
  )

  // T-A3c
  effect('says which way toolArgs was unreadable', () =>
    Effect.gen(function* () {
      const rules = yield* rulesOf(noAsAny)

      const notJson = yield* decide(rules, { toolArgs: 'not json', toolName: 'edit' }, { agent: 'copilot' })
      expect(notJson._tag).toBe('Report')
      expect(problemOf(notJson)).toContain('as a string that is not JSON')

      const notAnObject = yield* decide(rules, { toolArgs: 7, toolName: 'edit' }, { agent: 'copilot' })
      expect(notAnObject._tag).toBe('Report')
      expect(problemOf(notAnObject)).toContain('carried no toolArgs')
    }),
  )

  // T-A3d — an ABSENT input key keeps its own message, which is what pins "byte-identical without
  // the flag" for the diagnostic text and not just for the exit codes. "carried tool_input as a
  // string that is not JSON" would be both a default-path change and untrue.
  effect('keeps the absent-input message each contract already had', () =>
    Effect.gen(function* () {
      const rules = yield* rulesOf(noAsAny)

      const claudeCode = yield* decide(rules, { tool_name: 'Write' })
      expect(problemOf(claudeCode)).toBe('Write carried no tool_input')

      const copilot = yield* decide(rules, { toolName: 'edit' }, { agent: 'copilot' })
      expect(problemOf(copilot)).toBe('copilot: edit carried no toolArgs')

      // Neither spelling present at all: the first one this contract documents is the one named,
      // because that is the one a hook author writing a fresh config will have reached for.
      const neither = yield* decide(rules, {}, { agent: 'copilot' })
      expect(problemOf(neither)).toBe('copilot: hook payload carried no toolName')
    }),
  )

  // The forward gap, closed. A camelCase Copilot payload under the default contract cannot be
  // recognised as a misdeclaration — nothing in that contract reads `toolName`, so there is no tool
  // name to look up — but the ENVELOPE is still recognisable, and naming it turns issue #50's
  // opening message from a dead end into the remedy. One branch on a path that was already
  // Malformed; the message a payload speaking no known envelope gets is untouched.
  effect('names the contract whose envelope arrived when this one carried none', () =>
    Effect.gen(function* () {
      const rules = yield* rulesOf(noAsAny)

      const camelCase = yield* decide(rules, { toolArgs: { path: '/repo/src/a.ts' }, toolName: 'edit' })
      expect(problemOf(camelCase)).toBe(
        'hook payload carried no tool_name (it carried toolName, which belongs to the copilot contract — did you mean --agent copilot?)',
      )

      // No known envelope at all keeps the message it has always had, in either contract.
      expect(problemOf(yield* decide(rules, { nothing: 1 }))).toBe('hook payload carried no tool_name')
      expect(problemOf(yield* decide(rules, { nothing: 1 }, { agent: 'copilot' }))).toBe(
        'copilot: hook payload carried no toolName',
      )
    }),
  )

  // R9 — an empty argument object rendered as a dangling `carried: )`. The keys that arrived are
  // the whole point of the clause, and "none of them" is a thing worth saying in words.
  effect('says so in words when the arguments carried no keys at all', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), { tool_input: {}, tool_name: 'Write' })

      expect(problemOf(decision)).toBe('Write carried no content/file_path to judge (tool_input carried nothing)')
    }),
  )

  // R9 — every other Copilot diagnostic names the contract; this one did not, so a reader seeing it
  // could not tell which contract had rejected their payload.
  effect('prefixes the not-an-object complaint with the contract too', () =>
    Effect.gen(function* () {
      expect(problemOf(yield* decide(yield* rulesOf(noAsAny), 'nope', { agent: 'copilot' }))).toBe(
        'copilot: hook payload was not an object',
      )
      expect(problemOf(yield* decide(yield* rulesOf(noAsAny), 'nope'))).toBe('hook payload was not an object')
    }),
  )

  // T-A4a
  effect('judges a Copilot create by the content it would write', () =>
    Effect.gen(function* () {
      const decision = yield* decide(
        yield* rulesOf(noAsAny),
        {
          cwd: '/repo',
          toolArgs: { content: 'const x = value as any', path: '/repo/src/widget.ts' },
          toolName: 'create',
        },
        { agent: 'copilot' },
      )

      expect(decision._tag).toBe('Deny')
    }),
  )

  // T-A4b — GitHub documents no tool ARGUMENT names anywhere, so `content` is an inference and
  // `file_text` is the competing candidate. Naming what arrived is what makes a wrong inference
  // diagnosable in ten seconds instead of mysterious.
  effect('names both what it expected and what arrived when a field mapping does not match', () =>
    Effect.gen(function* () {
      const decision = yield* decide(
        yield* rulesOf(noAsAny),
        {
          cwd: '/repo',
          toolArgs: { file_text: 'const x = value as any', path: '/repo/src/a.ts' },
          toolName: 'create',
        },
        { agent: 'copilot' },
      )

      expect(problemOf(decision)).toContain('copilot: create carried no content/path to judge')
      expect(problemOf(decision)).toContain('file_text')
    }),
  )

  // T-A5 — nothing below `judgedTarget` learns an agent exists, and the freedom is worth pinning:
  // `cwd` is spelled `cwd` in both Copilot formats, so every repo-relative glob keeps working.
  effect('scopes a Copilot write by the same globs, relative to the same cwd', () =>
    Effect.gen(function* () {
      const scoped = yield* rulesOf(`${noAsAny}files:\n  - 'src/**/*.ts'\n`)
      const editOf = (path: string) => ({
        cwd: '/repo',
        toolArgs: { new_str: 'const x = value as any', old_str: '', path },
        toolName: 'edit',
      })

      expect((yield* decide(scoped, editOf('/repo/vendor/w.ts'), { agent: 'copilot' }))._tag).toBe('Defer')
      expect((yield* decide(scoped, editOf('/repo/src/w.ts'), { agent: 'copilot' }))._tag).toBe('Deny')
    }),
  )

  // T-A5b — the direction that would otherwise be silent. `--agent copilot` in front of Claude Code
  // emits exit 0 with nothing on either stream, so without this the installation is unguarded
  // indefinitely and looks healthy the whole time.
  effect('reports a payload whose tool belongs to the other contract, and says which flag to set', () =>
    Effect.gen(function* () {
      const rules = yield* rulesOf(noAsAny)

      const claudeCodePayload = yield* decide(
        rules,
        { tool_input: { content: 'const x = 1', file_path: '/repo/src/a.ts' }, tool_name: 'Write' },
        { agent: 'copilot' },
      )
      expect(claudeCodePayload._tag).toBe('Report')
      expect(problemOf(claudeCodePayload)).toContain('`Write`')
      expect(problemOf(claudeCodePayload)).toContain('claude-code contract')
      expect(problemOf(claudeCodePayload)).toContain('--agent claude-code')

      // The mirror is only reachable in the spelling the two contracts SHARE. Nothing in the
      // claude-code contract reads `toolName`, so a camelCase Copilot payload arriving here is
      // answered `hook payload carried no tool_name` — issue #50's opening line, and the loud
      // direction. Widening the default contract to read `toolName` would be a change to the
      // default path in order to improve a message, which is the wrong trade.
      const copilotPayload = yield* decide(rules, {
        tool_input: { new_str: 'const x = 1', old_str: '', path: '/repo/src/a.ts' },
        tool_name: 'edit',
      })
      expect(copilotPayload._tag).toBe('Report')
      expect(problemOf(copilotPayload)).toContain('`edit`')
      expect(problemOf(copilotPayload)).toContain('--agent copilot')
    }),
  )
})
