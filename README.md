# Robot Framework IDE

Desktop IDE (Electron) for [Robot Framework](https://robotframework.org) tests written with the
[Browser library](https://robotframework-browser.org). Only the Browser library is supported (no SeleniumLibrary).

Like VS Code, the IDE is installed once and works on any number of projects: on start it shows a welcome
screen to create a new project, open a folder or pick a recent project.

Features: projects, a **Robot Framework editor** (Monaco), **Test Generator** (like `playwright codegen`) and
**UI mode** (like Playwright's UI mode).

## Setup

```sh
npm install
npm run install-browsers     # Chromium for the recorder (playwright-core)
npm start                    # builds the editor bundle, then starts the app
                             # (npm run build && npx electron . <project folder>)
```

## Installer

```sh
npm run dist     # release/RobotFrameworkIDE-Setup-<version>.exe (NSIS, per-user, no admin rights)
npm run pack     # release/win-unpacked/ only, to try the packaged app without installing
```

The installed IDE needs, on the user's machine:

- **Python 3.10+** to create projects and run tests (each project gets its own `.venv`);
- **Node.js** only for `rfbrowser init` (the Browser library's own requirement);
- the **Chromium** used by the Test Generator: when it is missing, the Test Generator offers an
  *Install chromium* button (downloaded with the app's bundled Playwright, no Node.js needed).

The installer is not code-signed: Windows SmartScreen shows a warning on first run.

## Projects

**New project** creates a folder with the chosen name and initializes it:

```
<name>/
  tests/example.robot        example suite
  resources/common.resource  Library Browser + "Open Test Browser" keyword
  requirements.txt           robotframework, robotframework-browser
  rfide.json                 IDE settings (tests/resources/output folders, python)
  .gitignore, README.md
```

Optional setup steps (with live log): create `.venv` and `pip install -r requirements.txt` (needs Python 3.10+),
`rfbrowser init` (needs Node.js), `git init` + initial commit. If a step fails the folder is kept and can be opened.

Any folder can be opened; `rfide.json` is optional. Recent projects are stored in the IDE data folder, not in the projects.

## Editor

Files open in [Monaco](https://microsoft.github.io/monaco-editor/) (the VS Code editor). For `.robot` and
`.resource` files:

- syntax highlighting (sections, keywords, variables, FOR/IF/TRY, settings, assertion operators, comments)
- keyword completion (Ctrl+Space) from the libraries imported by the project (via `libdoc` with the project's
  Python) and the project's own keywords, with placeholders for required arguments; snippets for FOR/IF/TRY/...
- documentation on hover, Ctrl+click / F12 to jump to a user keyword's definition
- problems while typing: syntax errors from Robot's own parser (missing `END`, unknown settings, invalid
  sections, ...) and warnings for unknown keywords; counts in the tab header, F8 jumps to the next one.
  Unknown keywords are not reported when a library of the project cannot be imported.
- wrong keyword arguments, with Robot's own messages and rules (named-argument syntax, positional after named,
  multiple values, missing or too many arguments, missing named-only and unexpected named arguments); calls with
  `@{list}`/`&{dict}` arguments, embedded-argument keywords and ambiguous names are not checked
- Ctrl+S to save, ● on tabs with unsaved changes, confirmation before closing them

**● Record at cursor** (in the header of a `.robot`/`.resource` tab) records browser interactions straight into the
file: the steps appear live at the cursor, indented like the surrounding block, starting with `New Page    <url>`
(no settings, `New Browser` or `New Context`: the test is expected to have them). It uses the Test Generator's
browser and viewport; the editor is read-only while recording and one Ctrl+Z removes the whole recording.

**＋** in the explorer creates a file (e.g. `tests/login.robot`). Saving a test file refreshes the Testing panel.

## Test Generator

Enter a URL, choose browser and viewport, press **Record** and interact with the page. Use the toolbar
injected in the recorded page to pick locators and add assertions (visible, text, value, aria snapshot).
Steps can be removed from the list on the left; copy or save the generated `.robot` file (by default in the
project's `tests` folder).

Firefox/WebKit: `npx playwright-core install firefox webkit`. Chrome and Edge use the installed browsers.

## UI mode (Testing)

The **Testing** panel in the sidebar lists the suites and tests of the project's `tests` folder (parsed with Robot's
own API, using the project's `.venv`). Run everything, a suite or a single test (▶ on hover); with a filter (name or
tag) *Run all* runs only the visible tests. **Stop** kills robot and the browsers it started.

The **Test Results** tab shows the selected test while it runs: status, error, failure screenshots taken by the
Browser library, and the tree of executed steps (keywords, FOR/IF/TRY…) with timings and log messages.
*Go to source* opens the test at its line, *Open log* opens Robot's `log.html`. Results are written to `results/`.

*Show browser* runs with `--variable HEADLESS:False`, which the project template uses in `New Browser`.

**Trace viewer**: with *Record trace* (on by default) the Browser library records a Playwright trace for every
browser context created with `New Context` (`ROBOT_FRAMEWORK_BROWSER_TRACING`). The **Trace** button of a test opens
Playwright's trace viewer inside the IDE: Robot keywords as groups, DOM snapshots before/after each action, timeline,
console, network and source. A context created in a suite setup gives one trace for the whole suite. Contexts created
implicitly by `New Page` are not traced (Browser library behavior).

**Watch mode**: ◉ on a test or suite (or *Watch* for all tests) re-runs it when files change, whether saved in
the IDE or edited elsewhere. A changed suite file re-runs its own watched tests; a change to any other relevant file
(`.resource`, `.py`, variable files, ...) re-runs every watched test. The results folder is ignored, changes during
a run are queued, and watch runs do not switch tab.

## How it works

```
src/main/recorder.js         launches Playwright with its recorder enabled, collects actions
src/generator/selectors.js   Playwright selectors -> Browser selectors (role=, text=, >>> for frames)
src/generator/escape.js      Robot Framework argument escaping
src/generator/robotGenerator.js  actions -> Browser keywords (pure function)
src/main/testRunner.js       test discovery and robot execution (UI mode)
src/python/rfide_runner.py   runs in the project's Python: discovery, keyword index, libdoc, listener, test selection
src/main/keywordIndex.js     keywords for completion/hover (project index + cached libdoc)
src/main/languageWorker.js   persistent Python process (rfide_runner.py serve) for syntax checks
src/main/projectWatcher.js   file changes in the open project (watch mode, explorer, open tabs)
src/renderer/watchPlan.js    which watched tests to re-run for a set of changed files
src/main/traceServer.js      serves Playwright's trace viewer and the project's traces on 127.0.0.1
src/renderer/editor/         Monaco integration (bundled with esbuild by scripts/build.mjs into src/renderer/dist)
  robotSyntax.js             Robot line analysis shared by highlighting and completion
  argumentCheck.js           keyword calls and argument validation (mirrors Robot's argument resolver)
src/main/projects.js         create/open projects, setup steps, file tree
src/main/projectTemplate.js  files of a new project
src/main/recentProjects.js   recent projects list
src/main/main.js, preload.js Electron main process and IPC bridge
src/renderer/                UI (vanilla JS): app.js (welcome, projects, explorer), generator.js, tests.js
```

The recorder uses `BrowserContext._startRecording`, a **private** Playwright API. That is why
`playwright-core` is pinned to an exact version: when upgrading it, re-run the tests.

| Recorded action | Browser keyword |
|---|---|
| navigate / open page | `New Page`, `Go To` |
| click, double click, modifiers | `Click`, `Click With Options` |
| fill, press, select, check | `Fill Text`, `Press Keys`, `Select Options By`, `Check Checkbox` |
| assert text / value / checked / visible / snapshot | `Get Text`, `Get Property`, `Get Checkbox State`, `Get Element States`, `Get Aria Snapshot` |
| popup, dialog, download | `Switch Page`, `Handle Future Dialogs`, `Promise To Wait For Download` |

## Tests

```sh
npm test
```

`test/e2e.test.js` records real interactions, generates a `.robot` file and runs it with the Browser library.
It needs a Python environment with Browser installed (skipped otherwise):

```sh
python -m venv .venv
.venv/Scripts/pip install robotframework robotframework-browser   # .venv/bin/pip on Linux/macOS
.venv/Scripts/rfbrowser init chromium
```

or point `RFIDE_PYTHON` to an existing Python executable.
