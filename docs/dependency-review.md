# Dependency review — 2026-11-01

## Changes

Electron was updated from 45.0.0 to 45.2.1. This stable release includes upstream
Chromium fixes; see the [Electron release notes](https://releases.electronjs.org/release/v45.2.1).
The recorder remains on Playwright 1.64.1 because its integration uses private
recorder APIs and requires separate compatibility testing.

DOMPurify is pinned to 3.4.17, the patched version listed in
[GHSA-cg2g-xh64-v4q7](https://github.com/cure53/DOMPurify/security/advisories/GHSA-cg2g-xh64-v4q7).
The advisory describes a combination of template sanitization, DOM return modes,
attached shadow roots and downstream template evaluation. This review did not
establish that combination in Keywright. Replacing the affected dependency still
removes the old sanitizer from the shipped editor.

Monaco's vendored sanitizer needs a build-time replacement as well as an npm
dependency update. [Architecture](architecture.md#build-and-packaging) describes
the replacement and its regression check.

## Open findings

After these changes, `npm audit` reports 15 moderate package findings in the
Electron Builder dependency chain. They propagate from the
[minimatch globparts amplification advisory](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249).
They concern packaging tools rather than Keywright's production Node dependencies.
`npm audit --omit=dev` reports no findings; that result alone does not cover code
bundled from development dependencies, such as Monaco.

Electron Builder 26.18.0 is the current upstream release checked for this review.
The npm audit fix proposes downgrading it to 20.23.1. That downgrade was not applied.
Forcing minimatch 11 across the tree was also rejected: its
[changelog](https://github.com/isaacs/minimatch/blob/v11.0.3/changelog.md) removes
methods and changes the types stored in parsed patterns. Older consumers use
different APIs. A successful package build would not cover every affected path.

Keep these findings open until compatible upstream releases are available, then
repeat the full audit, editor bundle check, tests and Windows packaging checks.
Build patterns and package configuration should come from the reviewed repository.
This review does not establish the absence of other vulnerabilities.

## Verification

The local test suite passed all 116 tests with no skips, including recording real
form interactions and replaying the generated test with Browser library. The
renderer build passed. Inspection of the resulting Windows ASAR confirmed
DOMPurify 3.4.17 in the editor bundle, no copy of Electron Builder in the app, and
unpacked Python helpers and Playwright CLI files.

The unsigned Windows app was launched with a disposable project and a separate
user-data directory. The checks covered suite discovery, two passing browser
tests, Report and Log rendering, a completed trace with its DOM snapshot, and
keyword documentation in Monaco. An unsaved assertion change prompted for saving
before execution and produced the intended failure message. Restoring the
assertion and adding a saved recorder navigation produced three passing tests.
Cancelling a dirty-file close preserved the buffer; discarding the temporary
comment returned to the welcome screen without saving it.

The packaged recorder check covered launch, navigation, stop, save and replay.
Form input and clicks were exercised by the automated integration test; they were
not verified manually in the packaged recorder. Code
signing, installer execution and update installation were not verified.
