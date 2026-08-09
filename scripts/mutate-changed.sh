#!/usr/bin/env bash
# Mutation-test the source this branch changed, in a disposable worktree.
#
# WHY A WORKTREE. Stryker must run with `inPlace: true` — sandbox mode crashes before a single
# mutant runs, because its tsconfig preprocessor calls `ts.parseConfigFileTextToJson`, which
# TypeScript 7 removed (verified; see stryker.config.json). `inPlace` overwrites REAL files and
# restores them afterwards: fine for a throwaway checkout, unacceptable for the tree someone is
# working in, since interrupting the run would leave their source mutated. So it never sees it.
#
# The worktree is checked out at HEAD — the commit being pushed — so what gets mutated is what the
# push would publish, not whatever is dirty alongside it.
#
# WHAT IT ENFORCES, AND WHAT IT DOES NOT. `--mutate <file>` mutates the WHOLE file, not your hunk,
# so the score here is the file's, not your change's. This gate uses a deliberately low floor: it
# catches a change that guts a file's testability, not every file below the repo average. Three
# files sit under 88 today (doctor.ts 76, rule.ts 84, config-file.ts 85), so a break of 88 here
# would reject a comment-only edit to any of them.
#
# The repo-wide ratchet (break 88) belongs to `pnpm mutation`, which is deliberately NOT in CI — a
# full run costs about a minute per push and the value is in reading the survivors, not in a red
# tick. Run it when you want that reading; nothing runs it for you.
set -euo pipefail

repo="$(git rev-parse --show-toplevel)"
cd "$repo"

# A floor, not the bar. Lowest committed per-file score is 76.5; this catches a collapse.
FLOOR=70

# WHY THE SKIP IS OPT-OUT. Exiting 0 with no base is right on a laptop: a branch with no `main` to
# compare against has no "what this branch changed" to score, and a pre-push hook must not refuse a
# push it has nothing to say about. It is catastrophic in CI, where a default `actions/checkout`
# clones with `fetch-depth: 1` and no `origin/main` exists at all — so the obvious CI job takes this
# branch on every pull request, prints `skipping`, and goes green having mutated nothing. A guard
# against tests that cannot fail, which is itself a check that cannot fail.
#
# `MUTATION_REQUIRE_BASE=1` says the base is a precondition of this invocation rather than a
# convenience, so its absence is the failure it actually is. Set by the workflow, not by the hook.
#
# `MUTATION_BASE_REF` names the branch this work is actually being merged into, and the workflow
# passes the pull request's own base. Hard-coding `main` is not a hole — it is stricter, not weaker —
# but on the stacked branches AGENTS.md prescribes ("branch B off A's branch, not off `main`") it
# scores the PARENT branch's files as well, so B waits about a minute a file for a score it cannot
# act on, and a red tick nobody can act on is one people learn to ignore.
base_ref="${MUTATION_BASE_REF:-main}"
base="$(git merge-base HEAD "origin/$base_ref" 2>/dev/null || git merge-base HEAD "$base_ref" 2>/dev/null || true)"
if [ -z "$base" ]; then
  if [ -n "${MUTATION_REQUIRE_BASE:-}" ]; then
    echo "mutation: no merge-base with origin/$base_ref or $base_ref, and MUTATION_REQUIRE_BASE is set." >&2
    echo "mutation: refusing to report success on a comparison that never happened. Fetch that" >&2
    echo "mutation: branch with its history (actions/checkout with fetch-depth: 0)." >&2
    exit 1
  fi
  echo "mutation: no $base_ref branch to diff against, skipping"
  exit 0
fi

# Two pathspecs: git's `**` requires an intervening directory, so `src/**/*.ts` alone silently
# misses every top-level file such as `src/index.ts`. Stryker's globby `**` does not, so the two
# would have disagreed about what is in scope.
#
# `R` is in the filter because a rename-plus-rewrite is exactly the change worth mutating, and
# `ACM` alone drops it.
touched="$(git diff --name-only --diff-filter=ACMR "$base"...HEAD -- 'src/*.ts' 'src/**/*.ts' || true)"

sources="$(grep -vE '\.(test|test-d|bench)\.ts$' <<<"$touched" | grep -vE '^src/cli\.ts$' || true)"

# A branch that only WEAKENS a test changes no source file at all, and "this test no longer
# constrains the code" is precisely the defect this gate exists to catch — so filtering tests out
# and stopping made the guard skip the one change it was built for. Reproduced on this repository:
# deleting every assertion about `appliesTo` from `src/checking/scope.test.ts`, touching nothing
# else, left the suite green and printed `no mutatable source changed on this branch, skipping`.
#
# Each changed test therefore pulls in the implementation it is the test FOR, mapped structurally by
# this repository's own file-role convention — `x.test.ts` beside `x.ts` — and never by guessing
# from content which sources a test exercises. A test whose subject is not its sibling
# (`cli.e2e.test.ts`, `corpus.test.ts`, `documented.test.ts`) pulls in nothing, which is honest: it
# is a whole-suite test, and there is no one file whose score answers for it.
#
# What this buys, measured on that same reproduction: the run happens and reports `scope.ts` at
# 90.38% with 15 survivors, instead of skipping. It did NOT go red, because the rest of the suite
# still kills most of what that describe block was killing and 90.38 clears the floor of 70. The
# floor catches a collapse, not an erosion, and `--mutate <file>` scores the whole file rather than
# the change — so a per-file floor cannot see "this file scored worse than it did on main". A
# ratchet against the base commit's score would, at the cost of scoring every file twice. Not built;
# named here so the next reader does not have to rediscover it.
subjects=''
while IFS= read -r test; do
  [ -n "$test" ] || continue
  subject="${test%.test.ts}.ts"
  if [ "$subject" != "$test" ] && [ "$subject" != 'src/cli.ts' ] && [ -f "$subject" ]; then
    subjects="${subjects}${subject}"$'\n'
  fi
done < <(grep -E '\.test\.ts$' <<<"$touched" || true)

changed="$(printf '%s\n%s' "$sources" "$subjects" | grep -vE '^[[:space:]]*$' | sort -u || true)"

if [ -z "$changed" ]; then
  echo "mutation: no mutatable source changed on this branch, skipping"
  exit 0
fi

echo "mutation: $(echo "$changed" | wc -l | tr -d ' ') changed file(s), floor ${FLOOR}%"
echo "$changed" | sed 's/^/  /'

# A previous run killed mid-flight can leave an admin entry behind that `rm -rf` cannot clear.
git worktree prune

work="$(mktemp -d)/repo"
cleanup() {
  cd "$repo"
  git worktree remove --force "$work" 2>/dev/null || true
  rm -rf "$(dirname "$work")"
  git worktree prune
}
# INT/TERM/HUP as well as EXIT: bash does not run an EXIT trap for an unhandled signal, so Ctrl-C
# on a slow hook leaked both the temp directory and a live worktree entry into the real repo.
trap cleanup EXIT INT TERM HUP

git worktree add --detach --quiet "$work" HEAD
# Symlinked rather than installed: pnpm's store makes a fresh install slow and Stryker only reads
# from here. Verified that nothing writes back through it.
ln -s "$repo/node_modules" "$work/node_modules"

# Derived from the committed config rather than duplicated, so the two cannot drift. `allowEmpty`
# matters: a module reachable only through `cli.ts` or exercised only by the e2e suite (which spawns
# a subprocess, so there is no import edge for vitest `--related` to follow) yields no tests, and
# Stryker treats that as a configuration error rather than a pass.
#
# Its price, which is real: a source file that NO test reaches is then a pass here too. Measured —
# committing a two-function `src/scanning/quota.ts` that nothing imports gives `Instrumented 1 source
# file(s) with 11 mutant(s)`, `No tests were found`, exit 0. What catches that file is
# `pnpm coverage:ci`, whose 100% thresholds report it at 0% and fail the run, so the pull request is
# still red — by the other gate, not this one. Do not read a green mutation step as "these mutants
# were killed" without looking at how many ran.
node -e '
  const fs = require("fs")
  const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
  config.thresholds = { ...config.thresholds, break: Number(process.argv[3]) }
  config.allowEmpty = true
  config.reporters = ["json", "clear-text"]
  fs.writeFileSync(process.argv[2], JSON.stringify(config, null, 2))
' "$repo/stryker.config.json" "$work/stryker.changed.json" "$FLOOR"

cd "$work"
status=0
pnpm stryker run ./stryker.changed.json --mutate "$(echo "$changed" | paste -sd, -)" || status=$?

# Kept out of the worktree, which is about to be deleted — otherwise the report the run just told
# you to read is gone by the time you look.
if [ -f "$work/reports/mutation/mutation.json" ]; then
  mkdir -p "$repo/reports/mutation"
  cp "$work/reports/mutation/mutation.json" "$repo/reports/mutation/changed.json"
  echo "mutation: report at reports/mutation/changed.json"
fi

exit "$status"
