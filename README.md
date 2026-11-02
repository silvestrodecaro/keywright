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

### Prerequisites

Use Windows 10/11 and install these tools:

| Tool | Version to use | Check in PowerShell |
| --- | --- | --- |
| [Node.js](https://nodejs.org/en/download) with npm | 24.x | `node --version` and `npm.cmd --version` |
| [Python](https://www.python.org/downloads/windows/) | 3.13.x, available through the Windows `py` launcher | `py -3.13 --version` |
| [Git](https://git-scm.com/install/windows) | A current Windows version | `git --version` |

Close and reopen PowerShell after installing the tools. These are the Node and
Python versions used by CI; exact tested package versions are listed in
[Contributing](CONTRIBUTING.md#verified-environment).

### Install and launch

Run these commands in PowerShell. They create a `keywright` folder in your user
folder; use another short, writable location if you prefer.

```powershell
cd $env:USERPROFILE
git clone https://github.com/silvestrodecaro/keywright.git
cd keywright
npm.cmd ci
npm.cmd exec -- install-electron
npm.cmd run install-browsers
npm.cmd start
```

The install commands download the app's dependencies, Electron and the recorder's
Chromium browser. `npm.cmd start` builds the editor and opens the Keywright welcome
screen. If a command fails, see [startup troubleshooting](docs/troubleshooting.md#starting-keywright-from-source)
before continuing. The `.cmd` spelling also works when PowerShell blocks `npm.ps1`.

These commands prepare the IDE. Each Robot Framework project has its own Python
environment and Browser installation, prepared in the next step.

For later launches, open PowerShell in the same `keywright` folder and run
`npm.cmd start`. After pulling changes that update dependencies, repeat the three
install commands before starting the app.

## First run

1. Choose **New project**, enter a name such as `my-web-tests` and select a short,
   writable parent folder. Your user folder is usually suitable. The full project
   path must be at most 85 characters when installing browsers on Windows.
2. Keep virtual environment and browser installation enabled, then choose
   **Create project**. The wizard creates `.venv`, installs the Python packages and
   downloads Browser's browsers. Wait for the setup steps to finish, then choose
   **Open project**. If a step fails, its output remains visible and the folder is
   kept: see [repair a partial setup](docs/troubleshooting.md#project-setup-stopped-partway-through).
3. Select **Testing → Run all**. The generated project contains one test, so the
   expected result is **one passing test**. It opens `https://example.com` and
   requires network access. The footer should show the Python executable inside
   this test project's `.venv`.

To try recording and failure analysis with a supplied local page, follow
[Record a test and investigate a failure](docs/walkthrough.md). That example has
two tests and works offline after its dependencies and browsers are installed.

Already have Robot tests? Choose **Open folder…** and select their project folder.
If they need an environment or use a different layout, follow
[open an existing project](docs/user-guide.md#open-an-existing-project). Opening a
folder reads its files; environment setup is a separate step.

## Documentation

| Document | Contents |
| --- | --- |
| [Walkthrough](docs/walkthrough.md) | Run the supplied example, record a test, reuse a resource and inspect a failure |
| [User guide](docs/user-guide.md) | Projects, editor, recording, execution, debugging, configuration and shortcuts |
| [Troubleshooting](docs/troubleshooting.md) | Environment setup, discovery, browser launch, missing traces and editor issues |
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
