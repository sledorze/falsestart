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
# so the score here is the file's, not your change's. The repo-wide ratchet (break 88) is enforced
# by the full `pnpm mutation` run in CI. This gate uses a deliberately low floor: it exists to catch
# a change that guts a file's testability, not to hold every file to the repo average. Three files
# sit below 88 today (doctor.ts 76, rule.ts 84, config-file.ts 85), so a break of 88 here would
# reject a comment-only edit to any of them.
set -euo pipefail

repo="$(git rev-parse --show-toplevel)"
cd "$repo"

# A floor, not the bar. Lowest committed per-file score is 76.5; this catches a collapse.
FLOOR=70

base="$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null || true)"
if [ -z "$base" ]; then
  echo "mutation: no main branch to diff against, skipping"
  exit 0
fi

# Two pathspecs: git's `**` requires an intervening directory, so `src/**/*.ts` alone silently
# misses every top-level file such as `src/index.ts`. Stryker's globby `**` does not, so the two
# would have disagreed about what is in scope.
#
# `R` is in the filter because a rename-plus-rewrite is exactly the change worth mutating, and
# `ACM` alone drops it.
changed="$(git diff --name-only --diff-filter=ACMR "$base"...HEAD -- 'src/*.ts' 'src/**/*.ts' |
  grep -vE '\.(test|test-d|bench)\.ts$' |
  grep -vE '^src/cli\.ts$' ||
  true)"

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
