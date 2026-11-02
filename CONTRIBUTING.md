# Contributing

Use the [issue tracker](https://github.com/silvestrodecaro/keywright/issues) for
reproducible defects and proposed changes. For a change of more than a few lines,
open an issue first to agree on its scope. Include a small example and remove
credentials and private application data from attached artifacts.

## Development setup

Development and integration tests currently target Windows. Use Node.js 24 and npm
for the app, and Python for Robot integration tests. CI uses the same Node.js
version. The lockfile records the JavaScript dependency tree.

From the repository root:

```powershell
npm ci
npm exec -- install-electron
npm run install-browsers
npm start
```

`npm start` builds the editor bundle before launching Electron. To open a test
project directly, use `npm start -- "C:\Projects\my-web-tests"`. The test project
can have a different Python environment from the repository's integration-test
environment.

`npm run build:watch` rebuilds Monaco's integration bundle on source changes. It
does not automatically reload the Electron window. Generated files under
`src/renderer/dist/` should not be edited or committed.

## Tests

```powershell
npm test
```

The suite uses Node's test runner. Pure JavaScript tests cover source generation,
selector conversion, editor analysis, search, watch selection and history. Other
tests exercise a real recorder, locator picking, Robot execution, debugging,
formatting and the Python language worker.

For the complete suite, prepare a repository-local environment and the Chromium
versions needed by both toolchains:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m Browser.entry init chromium
npm run install-browsers
npm test
```

Python-backed tests select `KEYWRIGHT_PYTHON` when set, otherwise a repository `.venv`.
To use another prepared interpreter in PowerShell:

```powershell
$env:KEYWRIGHT_PYTHON = "C:\Environments\keywright-tests\Scripts\python.exe"
npm test
```

Review the test summary. Some integration tests are skipped when an interpreter is
absent, and formatting tests can be skipped without Robocop. A green run with
skips does not verify those integrations. An interpreter that exists but lacks
the required packages can cause failures rather than skips.

Run a focused file when working on one boundary:

```powershell
node --test test/generator.test.js
node --test test/debugger.test.js
```

For editor-integration or bundling changes, also run `npm run build`. Changes to the
recorder require the real recording/replay and locator-picking tests: the app uses
private Playwright recorder APIs, so generated-string tests alone are insufficient.
If a failure is intermittent, capture its output and determine the cause; a passing
retry does not establish that it is fixed.

### Desktop UI tests

After preparing the integration-test environment above and installing Electron
as described in the development setup, run:

```powershell
npm run test:ui
```

This builds the renderer and runs [Playwright tests](test/ui/keywright.spec.js)
against the source app in Electron. Each test starts with a new profile and a
temporary copy of the example project, using `KEYWRIGHT_PYTHON` or the repository
`.venv`. Missing prerequisites fail the check rather than skipping it.

The checks open the example through the welcome screen and run both tests using
**Testing → Run all**. A second scenario changes an assertion in the temporary
copy, checks the failure message and rendered screenshot, then uses **Go to source**
to open the test in Monaco. Only the native folder dialog's selected path is
supplied by the fixture; project loading, IPC, execution and result rendering run
through the application. A startup check also verifies that a supplied project
path is loaded when Electron debugger switches precede the app path. Profiles and
project copies are removed after each test.

Tests run one at a time without automatic retries. On failure, `out/ui-tests/`
contains the window screenshot, Playwright trace, Electron log and available Robot
results. The HTML report is in `out/ui-report/`. Inspect it with
`npx playwright show-report out/ui-report`.

The [Verify workflow](.github/workflows/verify.yml) prepares both browser toolchains,
runs the component and integration tests, executes the example's Robot Framework
tests from the command line, then builds and tests Keywright's UI on Windows for
pushes and pull requests. Failed UI runs upload their evidence as the
`keywright-ui-failure` artifact for seven days. GitHub branch protection must
separately require the check if merges should depend on it.

## Verified environment

The local verification on 2026-11-01 used this combination. The Python baseline is
pinned in [requirements-dev.txt](requirements-dev.txt); the JavaScript dependency
tree is recorded in `package-lock.json`. This is a tested combination, not a claim
that every version accepted by the project creator is compatible.

| Component | Verified version |
| --- | --- |
| Platform | Windows |
| Development Node.js | 24.16.0 |
| Python | 3.13.14 |
| Robot Framework | 7.5 |
| Browser library | 20.6.0 |
| Robocop | 9.1.2 |
| Electron | 45.2.1 |
| Recorder Playwright | 1.64.1 |

The [Keywright example project](examples/browser-walkthrough/) has two local browser tests.
From the repository root, use the prepared integration-test Python to verify it:

```powershell
.\.venv\Scripts\python.exe -m robot --outputdir examples/browser-walkthrough/results examples/browser-walkthrough/tests
```

## Application structure

Read [Architecture](docs/architecture.md) for process ownership, data flows and
integration contracts. The main areas are:

| Directory | Contents |
| --- | --- |
| `src/main/` | Electron lifecycle, IPC, project services, Playwright recorder and process management |
| `src/python/` | Helpers and listener running in the test project's Python |
| `src/generator/` | Pure action-to-Robot generation, escaping and selectors |
| `src/renderer/` | UI panels, styles and shared browser/Node-compatible logic |
| `src/renderer/editor/` | Monaco providers and Robot analysis helpers |
| `test/` | Node tests, local fixtures and Python/Browser integration checks |
| `scripts/` | Renderer build and signed-installer update metadata |

Keep public documentation and UI copy in English. Use real UI labels, explain
failure recovery and keep examples aligned with the implementation. Update the
user guide when a user-visible behavior changes.

## Local packaging checks

Installer releases are on hold while the source project is being stabilized.
CI runs tests and builds the editor. Packaging remains available for checking
Electron's bundled paths and runtime behavior locally.

```powershell
npm run pack
npm run dist
```

`pack` produces `release/win-unpacked/`; `dist` produces the NSIS installer under
`release/`. Both build the renderer first. Python helpers and `playwright-core`
must remain accessible outside ASAR in the packaged app.

Before distributing a build, check the packaged app with an existing project:
launch, load suites, record and replay a small interaction, inspect a failure,
open Report/Log and a completed trace, and confirm dirty-file handling on close.
An unsigned local package does not verify signing or the update path.

For an isolated check, use
`npx electron-builder --win --dir --publish never --config.directories.output=out/package-check`
after building the renderer, then launch `Keywright.exe` with
`--user-data-dir=<temporary-profile>` and a disposable project path. This keeps
the check's recent projects and editor settings separate from the normal profile.

Review both `npm audit` and `npm audit --omit=dev` when updating dependencies.
The second command excludes Monaco and DOMPurify because they are build
dependencies, even though their code is bundled into the app. The editor build
test checks which sanitizer actually reaches that bundle. See the dated
[dependency review](docs/dependency-review.md) for unresolved findings.

`npm run release` publishes artifacts to GitHub. It is separate from development
and local verification; public installer releases are not part of the current
workflow.
