---
'@sledorze/falsestart': minor
---

Closes four ways a rule could silently fail to protect anything.

**Repo-relative `files` globs now work.** A hook reports an absolute path (`/repo/src/a.ts`) while
rules are authored relative to the project (`src/**/*.ts`), so any rule scoped that way previously
loaded, validated, and matched nothing — indistinguishable from a clean file. Paths are now
re-expressed relative to the payload's `cwd` before scoping. **This can flip a previously-silent
repository to blocking:** rules you believed were inert may now fire. A file outside the project
root keeps its absolute path.

**Matcher shapes the ast-grep CLI rejects are now rejected here too.** The napi binding accepts
`all: [pattern, regex]` with no `kind` and then matches essentially every node, so such a rule
fired indiscriminately instead of failing. It now reports as a rule error, along with an empty
`all`. **A rule tree containing one of these will now report an error where it previously
"worked".**

**`NotebookEdit` is judged.** It writes real source and was silently unchecked. Note that notebooks
scope by the notebook's path, so a rule scoped to `**/*.ts` will not see a `.ipynb` cell — add
`**/*.ipynb` if you want it to.

**Shared matchers.** A `_utils/` directory inside the rule tree holds matchers any rule can
reference by `matches:`. Previously a matcher needed by several rules had to be copy-pasted into
each one's local `utils:`; a cross-file reference failed outright with "invalid matches reference".
