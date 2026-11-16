# Dependency review — 2026-11-16

## Audit scope

`npm audit` reports zero known vulnerabilities in the current lockfile, including
development dependencies. CI runs `npm audit --audit-level=moderate` on Node.js 24
and 26 and fails for moderate or higher findings.

Audit results describe the advisories available at the time of the check. They do
not cover the project's Python packages or every possible defect in the app.
Review the complete npm tree when changing dependencies: `--omit=dev` excludes
Monaco and DOMPurify even though their code is bundled into the editor.

## Removed packaging dependency chain

The previous audit reported 15 moderate package findings, all propagated from
the [minimatch pattern amplification advisory](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249)
through Electron Builder. These were affected packages in one dependency chain,
not 15 separate advisories.

The 2026-11-02 review checked Electron Builder 26.18.0. Its dependency tree
contained affected minimatch versions. npm proposed downgrading Electron Builder
to 20.23.1. Forcing minimatch 11 across older consumers would change their API
contract.

Installer distribution is deferred until the installer and its updates can be
code-signed; meanwhile Keywright is developed and tested from source. Electron Builder and its transitive dependencies have therefore been
removed from `package.json` and the lockfile. The packaging configuration,
`pack`, `dist` and `release` commands, and installer metadata script were removed
with them. The source app, renderer build and tests do not use these tools.

The obsolete installer update client, `electron-updater`, has also been removed.
The welcome screen provides source update instructions for Git clones and ZIP
downloads. No updater service runs in the app.

The audit runs on the full remaining tree. No advisories are suppressed and no
dependency overrides were added for minimatch. Reintroducing packaging requires
a new dependency review and checks of the packaged app, signing and update path.

## Editor dependencies

The lockfile uses Electron 45.2.1 and Playwright 1.65.0. The recorder uses
private Playwright APIs. The regression suite exercises real recording,
locator picking and replay with the Browser library after an upgrade.

DOMPurify remains pinned to 3.4.17, the patched version listed in
[GHSA-cg2g-xh64-v4q7](https://github.com/cure53/DOMPurify/security/advisories/GHSA-cg2g-xh64-v4q7).
Monaco imports a vendored sanitizer, so updating the npm dependency alone would
leave that copy in the editor. The build replaces the vendored import with the
pinned package. `editorBuild.test.js` inspects the actual bundle inputs to verify
the replacement. See [Architecture](architecture.md#build-and-packaging).

## Verification

The Windows checks for Keywright 0.5.0 passed on Node.js 24.16.0 and Python 3.13.14.

- A clean `npm ci` installed 27 packages. The complete audit and
  `npm audit --omit=dev` both reported zero findings.
- `setup.bat --check --no-pause` passed the prerequisite checks. Robot Framework
  ran both Browser tests in the example successfully.
- `npm.cmd run test:regression` passed 236 Node tests and 32 desktop UI tests
  with zero skips. It includes the recorder integration, the editor sanitizer
  check and Source Control workflows using temporary Git repositories.
