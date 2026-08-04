---
'@sledorze/falsestart': minor
---

Ship `CHANGELOG.md` inside the published package, and name it in `--doctor`.

It was not in the `files` array, so it was not in the tarball. Someone upgrading `0.1.0` → `0.2.0`
had to `npm pack` both versions and `diff -rq` the `rules/` trees by hand to find out what had
changed. That is a bad trade for any dependency and a worse one for this one: `0.2.0` added
`no-empty-catch` and `no-hardcoded-credential`, both `error` severity, both in `clean-code` — so a
MINOR bump made `--preset clean-code` and `--preset all` strictly stricter, and a repo that passed
yesterday failed today with nothing in the package to say why. The release notes said all of that
already; they were simply not shipped.

`--doctor` now prints a `changes` line under the version, pointing at the changelog in the
installation it is reporting on:

```
falsestart <the installed version>
changes  …/CHANGELOG.md — what this version changed, including any rule that is new
```

That is where it belongs rather than only in the tarball, because `--doctor` is what people already
run to verify an upgrade. The path is anchored on the running module, so it is the changelog for the
copy every other line in the report describes — not a guess at `node_modules/@sledorze/falsestart`,
which is not where every package manager puts it.

The line is printed only when a readable FILE is really there — `stat`, not `exists`, so a directory
of that name is not mistaken for release notes — and an installation of `0.1.0` or `0.2.0` still
reports exactly as it did.

`DiagnoseOptions` gains `changelogPath`, and it is **optional**. That is the whole reason the claim
below holds: `DiagnoseOptions` is part of the published library surface, so a required field would
have been a compile error in every existing caller of `diagnose` — a minor bump turning a consumer's
`tsc` red, which is precisely the surprise this change exists to spare people. Omitting it is a
supported call that reports no `changes` line.

No behaviour changes for any judged write, and no previously-passing repo can go red because of this.
