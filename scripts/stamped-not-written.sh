#!/usr/bin/env bash
# A summary whose sidecar hash changed while its prose did not was STAMPED, not rewritten.
#
# `cairn check` detects staleness correctly, and `pnpm stamp` clears it in one command — so the
# documented remediation satisfies the check without performing the remediation. That loop is how
# four summaries went stale under a green check in a single week; every one was caught by a reviewer
# reading the prose, never by a tool.
#
# This belongs HERE and not in cairn, which a first pass got backwards.
#
# It is a policy, not an invariant. Every cairn check is a property of the tree — the summary exists,
# its hash matches, the link resolves. "A human rewrote the digest" is a claim about how a commit was
# made, and measured over sixty commits it is false 21% of the time with everything correct: 18 of 86
# doc edits changed a source without its summary, median four added lines, almost all a row appended
# to a reference table. Shipped to every cairn adopter that is a check firing on one doc edit in
# five, mostly wrongly, and a check that noisy gets disabled.
#
# It also needs the git INDEX, which cairn's model has no concept of: cairn compares the working tree
# against a ref, and the question here only exists while something is staged.
#
# The known cost of keeping it local: the grep below encodes a sidecar layout cairn owns, so a change
# to that layout makes this pass vacuously. `.cairn/**` is committed and its shape is visible in any
# diff, which is the mitigation — not a strong one, and the reason to re-check it on a cairn upgrade.
#
# sledorze/cairn#131 covers the upstream half with a better shape than a new check: scoped and
# interactive stamping prevents the reflex rather than detecting it, so it has nothing to suppress.
#
# `_SUMMARY.md` is excluded, and that is deliberate rather than an oversight — it was undisclosed
# until a review called it a coverage gap, and testing the "fix" is what showed the exclusion is
# right. A directory summary is a link index over its children: its prose depends on the child SET,
# not on child content. But its hash is a Merkle hash over the children's hashes, so it goes stale on
# every descendant edit. Including it made the guard fire on a `_SUMMARY.md` whose prose was
# correct — near-100% false positives, which is the noise that gets a check disabled.
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
