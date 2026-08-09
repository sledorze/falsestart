#!/usr/bin/env bash
# A summary whose sidecar hash changed while its prose did not was STAMPED, not rewritten.
#
# `cairn check` detects staleness correctly, and `pnpm stamp` clears it in one command — so the
# documented remediation satisfies the check without performing the remediation. That loop is how
# four summaries went stale under a green check in a single week; every one was caught by a reviewer
# reading the prose, never by a tool.
#
# `.cairn/refs/**` is excluded: those sidecars record the hashes of files a doc LINKS to, so one
# changing means a cited source moved, not that this summary's prose is now wrong.
set -euo pipefail

# `STAGED_OVERRIDE` exists so this can be exercised without a real index.
# An explicit opt-out, because a source edit that genuinely leaves the digest true does happen —
# a typo fix, a reflowed table. It has to be SAID rather than defaulted to: it lands in the shell
# history of whoever claimed it, where the next reader can see who decided and when.
[ -n "${SUMMARIES_REVIEWED:-}" ] && exit 0

staged=${STAGED_OVERRIDE:-$(git diff --cached --name-only)}
offenders=()

while IFS= read -r summary; do
  [ -n "$summary" ] || continue
  grep -qxF "$summary" <<<"$staged" || offenders+=("$summary")
done < <(
  grep -E '^\.cairn/.*\.summary\.md\.json$' <<<"$staged" |
    grep -v '^\.cairn/refs/' |
    sed -e 's|^\.cairn/||' -e 's|\.json$||' || true
)

if [ ${#offenders[@]} -gt 0 ]; then
  printf 'These summaries were re-stamped but not rewritten:\n\n' >&2
  printf '  %s\n' "${offenders[@]}" >&2
  printf '\nThe hash says the source changed, so the digest of it probably should too. Rewrite the\n' >&2
  printf 'prose and stamp again.\n\n' >&2
  printf 'If you have read them and they genuinely still hold, say so explicitly:\n' >&2
  printf '  SUMMARIES_REVIEWED=1 git commit ...\n' >&2
  printf 'Staging an unchanged file cannot say it, because git has nothing to stage.\n' >&2
  exit 1
fi
