# Contributing

Use the [issue tracker](https://github.com/silvestrodecaro/keywright/issues) for
reproducible defects and proposed changes. For a change of more than a few lines,
open an issue first to agree on its scope. Include a small example and remove
credentials and private application data from attached artifacts.

## Development setup

Development and integration tests currently target Windows. CI covers Node.js 24
and 26 with Python 3.13. For the guided setup, use `setup.bat` as described in
[Run from source](README.md#run-from-source) first. The lockfile records the
JavaScript dependency tree.

For manual app setup, run these commands from the repository root:

```powershell
npm.cmd ci
npm.cmd exec -- install-electron
npm.cmd run install-browsers
npm.cmd start
```

`setup.bat --check` only checks prerequisites. `setup.bat --non-interactive`
performs the setup without prompts and fails if a system prerequisite is missing.
Use `--no-pause` when invoking it from another script. The batch launcher uses
Windows PowerShell for prerequisite checks; it does not change the system's
execution policy. Interactive installations through WinGet require confirmation.
The setup prepares the included example, not the repository's integration-test
environment described below.

The npm install-script policy permits the reviewed `esbuild@0.28.2` hook.
Review the policy when changing that version or adding another install script.

`npm.cmd start` checks the installed runtime, builds the editor and launches
Electron. Detailed command output is saved under `out/start/`. If the executable
is missing, start stops without downloading it; see the
[antivirus recovery guidance](docs/troubleshooting.md#antivirus-detects-electronexe).
To open a test
project directly, use `npm.cmd start -- "C:\Projects\my-web-tests"`. The test project
can have a different Python environment from the repository's integration-test
environment.

`npm.cmd run build:watch` rebuilds Monaco's integration bundle on source changes. It
does not automatically reload the Electron window. Generated files under
`src/renderer/dist/` should not be edited or committed.

## Tests

```powershell
npm.cmd test
```

The suite uses Node's test runner. Pure JavaScript tests cover source generation,
selector conversion, editor analysis, search, watch selection and history. Other
tests exercise a real recorder, locator picking, Robot execution, debugging,
formatting and the Python language worker.

To test changes to Keywright, prepare a `.venv` in the **Keywright repository
root**, alongside `package.json`. This environment is for the integration tests;
it is separate from the environments in your Robot projects. Install the Chromium
versions needed by both toolchains:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = "$env:LOCALAPPDATA\ms-playwright"
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m Browser.entry init chromium
npm.cmd run install-browsers
npm.cmd test
```

Python-backed tests select `KEYWRIGHT_PYTHON` when set, otherwise a repository `.venv`.
To use another prepared interpreter in PowerShell:

```powershell
$env:KEYWRIGHT_PYTHON = "C:\Environments\keywright-tests\Scripts\python.exe"
npm.cmd test
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

For editor-integration or bundling changes, also run `npm.cmd run build`. Changes to the
recorder require the real recording/replay and locator-picking tests: the app uses
private Playwright recorder APIs, so generated-string tests alone are insufficient.
If a failure is intermittent, capture its output and determine the cause; a passing
retry does not establish that it is fixed.

### Desktop UI tests

After preparing the integration-test environment above and installing Electron
as described in the development setup, run:

```powershell
npm.cmd run test:ui
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
`npx.cmd playwright show-report out/ui-report`.

The [Verify workflow](.github/workflows/verify.yml) prepares both browser toolchains,
runs the component and integration tests, executes the example's Robot Framework
tests from the command line, and runs `setup.bat` from a long directory containing
spaces. The UI tests then use that setup's Python environment, so Browser runs
from the nested location while finding executables in the shared cache. Both
Node.js versions run these checks on pushes and pull requests. Failed runs upload
their evidence as `keywright-failure-node-24` or `keywright-failure-node-26` for
seven days. GitHub branch protection must
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
$env:PLAYWRIGHT_BROWSERS_PATH = "$env:LOCALAPPDATA\ms-playwright"
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
| `scripts/` | Renderer build, Windows setup, launch and terminal progress |

Keep public documentation and UI copy in English. Use real UI labels, explain
failure recovery and keep examples aligned with the implementation. Update the
user guide when a user-visible behavior changes.

## Dependency review and distribution

Keywright currently runs from source. Installer distribution is deferred, and the
repository has no packaging or publishing commands. Electron Builder and its
dependency chain are excluded from the app's development setup.

Review both `npm audit` and `npm audit --omit=dev` when updating dependencies.
The second command excludes Monaco and DOMPurify because they are build
dependencies, even though their code is bundled into the app. The editor build
test checks which sanitizer actually reaches that bundle. CI runs
`npm audit --audit-level=moderate` on the complete npm tree and fails for moderate
or higher findings. See the dated [dependency review](docs/dependency-review.md)
for the current results and scope.
