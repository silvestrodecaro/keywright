<p align="center"><img src="docs/images/logo.svg" alt="Keywright" width="560"></p>

Keywright is a desktop IDE for [Robot Framework](https://robotframework.org/) web tests
using [Browser library](https://robotframework-browser.org/). Record a browser interaction
as Robot keywords, edit the test, run it, and inspect the failed keyword, screenshot
or Playwright trace from the same project.

[Run from source](#run-from-source) · [First run](#first-run) · [User guide](docs/user-guide.md) ·
[Troubleshooting](docs/troubleshooting.md) · [Development](CONTRIBUTING.md)

![A failed Robot test with its executed keywords and screenshot](docs/images/test-results.png)

## Working with tests

| Task | What Keywright provides |
| --- | --- |
| Write a browser test | Test Generator records actions and assertions as Browser keywords. Pick a locator or record steps directly into an open file. |
| Maintain a suite | Monaco editor with keyword completion and documentation, navigation, references, rename, quick fixes, argument checks and Robocop integration. |
| Run a test or suite | Test selection, tag filters, Robot arguments, dry run, streamed keyword results and re-runs when watched files change. |
| Investigate a failure | Source navigation, Browser screenshots, Robot logs and reports, context traces, breakpoints, stepping and variable inspection. |
| Compare results | A local history of the last 30 run summaries, including newly failing, fixed and slower tests. |

Tests remain ordinary `.robot` and `.resource` files. They can be edited in another
editor and run with the project's Python outside Keywright. Recorded code is a
starting point: review selectors and assertions, and move repeated behavior into
user keywords as the suite grows.

## Scope and status

Keywright is in early development, currently version **0.2.0**. Run it from source
while the project is being tested and refined. Installer releases are on hold.
Settings and behavior may change before 1.0.

- **Platform:** Windows 10/11. Development and integration tests currently target
  Windows; other desktop platforms have not been verified.
- **Browser integration:** Browser library. The recorder, locator picker,
  screenshots and trace integration target its Playwright backend.
- **SeleniumLibrary:** not a supported integration. Keywright does not generate
  SeleniumLibrary tests or translate existing SeleniumLibrary suites.
- **Projects:** a project-local `.venv` by default, or an explicit Python path in
  `keywright.json`. Existing layouts can configure the test and results directories.

See the guide for [configuration](docs/user-guide.md#project-configuration) and
[current limitations](docs/user-guide.md#current-limitations), including saved-file
execution and trace availability.

## Run from source

Install [Node.js 24](https://nodejs.org/), [Python](https://www.python.org/downloads/)
and [Git](https://git-scm.com/). Make Python available on `PATH`; the project creator
looks for Python 3.10 or later. The tested Python combination is recorded in
[Contributing](CONTRIBUTING.md#verified-environment).

In PowerShell:

```powershell
git clone https://github.com/silvestrodecaro/keywright.git
cd keywright
npm ci
npm exec -- install-electron
npm run install-browsers
npm start
```

`npm start` builds the editor and launches the Electron app. Python and the test
project's Browser dependencies are installed separately. The Test Generator has
its own browser installation; installing its Chromium does not prepare a project's
Python environment. Follow the first-run steps below to create that environment.

## First run

1. Choose **New project** on the welcome screen. Use a short location such as
   `C:\Projects`; Browser's installed browser executables can exceed Windows path
   limits in deeply nested projects.
2. Leave virtual environment and browser installation enabled. The setup view
   shows each step and its output. If a step fails, the project folder is kept so
   you can repair it.
3. Open the project, select **Testing**, and run the example suite. A successful
   result confirms the project's Robot and Browser setup can execute a test.
4. Open **Test Generator**, enter a URL and press **Record**. Add assertions with
   the toolbar in the recorded browser, then stop and save the generated `.robot`
   file under `tests/`.
5. Review the file and run it from **Testing**. Select its result to inspect the
   keyword steps. **Report** and **Log** show Robot's output from the latest run.

For a complete example, follow [Record a test and investigate a failure](docs/walkthrough.md).
It includes a local page and a runnable suite, with recording, reusable keywords
and an intentional assertion failure.

For an existing repository, choose **Open folder…**. Opening it does not install
dependencies or create an environment. Follow
[open an existing project](docs/user-guide.md#open-an-existing-project) if its Python
or test directory differs from the defaults.

## Documentation

| Document | Contents |
| --- | --- |
| [Walkthrough](docs/walkthrough.md) | Run the supplied example, record a test, reuse a resource and inspect a failure |
| [User guide](docs/user-guide.md) | Projects, editor, recording, execution, debugging, configuration and shortcuts |
| [Troubleshooting](docs/troubleshooting.md) | Environment setup, discovery, browser launch, missing traces and editor issues |
| [Existing projects](docs/migration.md) | Configuration, history and preferences created before the Keywright rename |
| [Contributing](CONTRIBUTING.md) | Development setup, tests, integration prerequisites and packaging |
| [Architecture](docs/architecture.md) | Electron/Python boundaries, application flows, persistence and integration contracts |

## Local data and network access

Project files and Robot output are stored in the project directories. Run summaries
are kept in the configured results folder; recent projects and interface settings
are stored in Electron's user-data directory. Keywright has no analytics or telemetry
integration in the application source.

Source runs do not check for application updates. Project setup downloads Python
packages and Browser dependencies; browser installation downloads browser binaries.
Recorded pages and executed tests make
the network requests their applications and test code require. Logs, screenshots
and traces may contain data from the system under test; review them before sharing.

## Contributing and support

Report a reproducible problem or propose a change in the
[issue tracker](https://github.com/silvestrodecaro/keywright/issues).
Include the Keywright version, project Python and relevant package versions, the
steps to reproduce, and a small example with sensitive data removed.

Development instructions are in [CONTRIBUTING.md](CONTRIBUTING.md).
Keywright is available under the [MIT license](LICENSE).
