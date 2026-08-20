/**
 * `pnpm verify` must run every gate CI applies.
 *
 * AGENTS.md records the rule as observed rather than theorised: `verify` once ran `pnpm test` while
 * CI ran `pnpm coverage:ci`, so a change with uncovered branches passed a full local verify and was
 * rejected at push. Adding the `mutation` job re-opened the same gap, and the paragraph stating the
 * rule sat seventy lines above the paragraph breaking it.
 *
 * Asserted from both files rather than from a list restated in a third place, so a gate added to CI
 * and forgotten in `verify` fails here rather than at somebody's merge.
 */
import { NodeServices } from '@effect/platform-node'
import { expect, layer } from '@effect/vitest'
import { Effect, FileSystem, Schema } from 'effect'
import { workflowSteps } from '../testSupport/workflow.ts'

const MANIFEST = `${process.cwd()}/package.json`

const ManifestSchema = Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) })

/**
 * Steps CI runs that `pnpm verify` deliberately cannot, each with the reason.
 *
 * An allowlist, because the alternative is a filter on SPELLING and that is exactly what leaked: the
 * first version of this check looked only at commands beginning `pnpm `, so the deletions step —
 * written `npx cairn …` — was never compared against `verify` at all. It was harmless, re-running
 * checks `pnpm check` had already made, but a real gate written with `npx` would have escaped
 * identically. How a command happens to be spelled cannot be the thing deciding whether it is
 * governed.
 *
 * Every entry is asserted to still match a step, so an exemption cannot outlive what it exempts.
 */
const CI_ONLY_STEPS: readonly { readonly because: string; readonly matches: string }[] = [
  {
    because:
      'compares deletions against the pull request BASE, which exists only on a pull request; locally `pnpm check` keeps cairn default of comparing the working tree against HEAD',
    matches: '--deletions-since',
  },
]

/**
 * Steps that prepare the runner and gate nothing, so `verify` has no business running them.
 *
 * Together with `CI_ONLY_STEPS` this is the whole of the exception surface, and that is the point:
 * the check below governs EVERY `run:` step and subtracts these two named lists, rather than
 * selecting the steps it feels able to judge. The previous two versions filtered on how a command
 * was spelled — first `pnpm `, then `pnpm ` or `npx ` — and a gate written `node scripts/x.js`,
 * `bash scripts/x.sh` or `./node_modules/.bin/oxlint` sailed past both. Widening the filter never
 * closes that; only inverting it does.
 */
const SETUP_STEPS: readonly { readonly because: string; readonly matches: string }[] = [
  { because: 'installs dependencies; there is nothing to verify locally', matches: 'pnpm install' },
  { because: 'fetches the base branch so a later step can compare against it', matches: 'git fetch' },
]

layer(NodeServices.layer)('CI and `pnpm verify`', (it) => {
  it.effect('run the same gates', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const parsed: unknown = JSON.parse(yield* fs.readFileString(MANIFEST))
      const manifest = yield* Effect.orDie(Schema.decodeUnknownEffect(ManifestSchema)(parsed))
      const verify = manifest.scripts['verify'] ?? ''

      const exempt = [...SETUP_STEPS, ...CI_ONLY_STEPS]
      // EVERY run step, then subtract the two named lists. Not "the steps that look like gates".
      const commands = (yield* workflowSteps)
        .map(({ step }) => (step.run ?? '').trim())
        .filter((command) => command !== '')

      expect(commands.length).toBeGreaterThan(0)

      // An exemption that outlives its step is a permanent hole, so each must still match something.
      // Typo `matches`, or delete the step it names, and this fails.
      for (const exemption of exempt) {
        expect(commands.some((command) => command.includes(exemption.matches))).toBeTruthy()
      }

      const governed = commands.filter((command) => !exempt.some((exemption) => command.includes(exemption.matches)))

      expect(governed.filter((gate) => !verify.includes(gate))).toEqual([])
    }),
  )
})
