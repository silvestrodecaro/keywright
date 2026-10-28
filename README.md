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
- Ctrl+click / F12 on a variable jumps to where it is defined: `[Arguments]`, assignments, `FOR`, `VAR`,
  `EXCEPT ... AS` and embedded arguments of the enclosing test or keyword, the `*** Variables ***` section,
  `Set Test/Suite/Global Variable`, then the imported resource files and Python/YAML variable files (recursively);
  hovering shows where it comes from and its value
- Ctrl+click / F12 on the path of a `Resource`, `Variables` or `Library` import opens the file (relative to the
  file or to the project root, `${CURDIR}` and `${/}` supported)
- Ctrl+Shift+O: outline of the file (sections, tests, keywords, variables, imports)
- F2 renames a keyword defined in the project or a variable: the keyword definition and its calls (BDD and
  `resource.` prefixes kept, setups/teardowns, `[Template]`, keywords passed to `Run Keyword` and similar) in the
  files that import it; a variable with its scoping (a local only in its test or keyword, a suite variable also in
  the files importing it, unless they define their own), including the `$name` form of IF/WHILE conditions,
  `Evaluate`-like keywords and inline Python. Open files get the edits as unsaved changes (Ctrl+Z undoes them),
  the others are saved. Library keywords, duplicate names, embedded arguments and variable files are not renamed.
- Shift+F12 lists the references of a keyword (library keywords too) or a variable in a peek view, with the same
  rules as F2; the definition is included, also when it is in a Python/YAML variable file.
- Ctrl+. (or the light bulb) offers quick fixes: for an unknown keyword, the most similar names and "Create
  keyword" in the file or in an imported resource (with `[Arguments]` from the call; the new keyword is shown);
  for an undefined variable, similar visible variables and "Define in the Variables section"; "Add END" for
  FOR/IF/WHILE/TRY blocks without END.
- problems while typing: syntax errors from Robot's own parser (missing `END`, unknown settings, invalid
  sections, ...) and warnings for unknown keywords; counts in the tab header, F8 jumps to the next one.
  Unknown keywords are not reported when a library of the project cannot be imported.
- wrong keyword arguments, with Robot's own messages and rules (named-argument syntax, positional after named,
  multiple values, missing or too many arguments, missing named-only and unexpected named arguments); calls with
  `@{list}`/`&{dict}` arguments, embedded-argument keywords and ambiguous names are not checked
- undefined variables (warnings): a variable must be defined in the file (with the scoping of tests and keywords)
  or in its resource and variable files. Not reported: built-in and environment variables, inline Python
  (`${{ }}`), documentation, and variables set at run time anywhere in the project (`Set Test/Suite/Global
  Variable`, `VAR ... scope=`). In `.resource` files, variables of the project's suites are accepted too, since
  keywords run in the scope of the suite that imports them. Nothing is reported for a file when one of its
  imports cannot be read statically (missing file, path with variables, module name, `get_variables()`).
  Variables given only on the command line (`--variable`) are reported: define a default in a Variables section.
- Shift+Alt+F (or Format Document in the right-click menu) formats the file with Robocop's formatter (the former
  Robotidy), run with the project's Python on the unsaved content; the project's `robocop.toml` (or `[tool.robocop]`
  in `pyproject.toml`) applies. When Robocop is missing, the editor offers to install it in the `.venv`; new
  projects get it in `requirements.txt`.
- Ctrl+S to save, ● on tabs with unsaved changes, confirmation before closing them

**Run from the editor**: in `.robot` files the gutter shows ▶ (or the last result: ✓ ✕ ↷) next to each test and
next to the `*** Test Cases ***` header. Clicking it runs that test, or every test of the file; the right-click menu
has **Run Test at Cursor** and **Run Tests in File**. Unsaved changes are saved first, and new tests are picked up
before running. Only files in the tests folder (`testsDir` in `rfide.json`) can be run.

**◎ Pick locator** (in the header of the tab) inserts the selector of the element you click in the browser at
the cursor; see [Test Generator](#test-generator).

**● Record at cursor** (in the header of a `.robot`/`.resource` tab) records browser interactions straight into the
file: the steps appear live at the cursor, indented like the surrounding block, starting with `New Page    <url>`
(no settings, `New Browser` or `New Context`: the test is expected to have them). It uses the Test Generator's
browser and viewport; the editor is read-only while recording and one Ctrl+Z removes the whole recording.

**＋** in the explorer creates a file (e.g. `tests/login.robot`). Saving a test file refreshes the Testing panel.

**Search** (Ctrl+Shift+F, with the editor's selection as the query) finds text in all the project's files, with
match case, whole word and regular expressions, and "files to include" globs (`*.robot, tests/`). The `.venv`,
`.git` and results folders and binary files are skipped. Click a result to open it with the match selected.
With a replacement, the results preview it (`$1` groups with regular expressions) and can be replaced one by one
(↻), per file or all at once (Replace all asks for a second click). Open files are searched with their unsaved
edits and get the replacements as unsaved, undoable changes; the other files are saved.

The **Problems** tab of the sidebar lists the errors and warnings of every `.robot` and `.resource` file of the
project, with the same checks as the editor (syntax, unknown keywords, arguments, undefined variables); the badge
shows how many there are. Open files show their live problems, unsaved edits included; the others are checked
again when files change. Clicking a problem opens the file at its position.

## Test Generator

Enter a URL, choose browser and viewport, press **Record** and interact with the page. Use the toolbar
injected in the recorded page to pick locators and add assertions (visible, text, value, aria snapshot).
Steps can be removed from the list on the left; copy or save the generated `.robot` file (by default in the
project's `tests` folder).

**◎ Pick locator** lets you click an element and shows its Browser library selector (e.g.
`role=button[name="Sign in"i]`), ready to copy. While recording it picks in the recorded browser and recording
goes on afterwards; otherwise it opens a browser at the URL above, which stays open for the next picks (click
the button again to cancel a pick). The same button in the header of a `.robot`/`.resource` tab inserts the
selector at the cursor, as a new cell.

Firefox/WebKit: `npx playwright-core install firefox webkit`. Chrome and Edge use the installed browsers.

## UI mode (Testing)

The **Testing** panel in the sidebar lists the suites and tests of the project's `tests` folder (parsed with Robot's
own API, using the project's `.venv`). Run everything, a suite or a single test (▶ on hover); with a filter (name or
tag) *Run all* runs only the visible tests. **Stop** kills robot and the browsers it started.

The **Test Results** tab shows the selected test while it runs: status, error, failure screenshots taken by the
Browser library, and the tree of executed steps (keywords, FOR/IF/TRY…) with timings and log messages. The
setups and teardowns of the suites containing the test are shown before and after its steps; a failing suite
teardown marks the suite's tests as failed, as in Robot's report.
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

**Debugging**: click the gutter left of the line numbers (or press F9) to set a breakpoint on a step of a `.robot`
or `.resource` file; breakpoints are kept per project. With *Debug* checked in the Testing panel, runs stop at
them: the paused line is highlighted in the editor and the Testing panel shows the call stack (click a frame to
open it) and the variables by scope (Local, Test, Suite, Global; built-in ones are left out). Continue (F5),
Step Over (F10), Step Into (F11), Step Out (Shift+F11), Pause and Stop are in the panel. Breakpoints changed
during a run apply right away (on the saved file: lines of unsaved edits may not match).

*Stop on failure* (on by default with *Debug*) pauses where a keyword fails, with its error message, before
teardowns run: the browser page is still there. Failures expected by TRY, `Run Keyword And Ignore Error`,
`Run Keyword And Return Status`, `Run Keyword And Expect Error` and `Wait Until Keyword Succeeds` are skipped.
While paused, the *Watch* input evaluates a variable (`${user}[name]`, `${obj.attr}`), a Python expression as in
`Evaluate` (`$count + 1`) or a keyword call with its arguments separated by two spaces (`Get Text    h1`);
results can be pinned (👁) as watches, evaluated again at every pause. Watches never run keywords. Keywords run
from the debugger are not shown in the IDE's results tree (Robot's log.html may list them).

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
  navigation.js              outline, variable definitions, undefined variables and imported files
  rename.js                  occurrences of keywords and variables for F2 rename
  quickFix.js                similar names, new keywords and variables, missing END
src/main/projectVariables.js variables set at run time / defined by suites across the project
src/main/projectSearch.js    search and replace in the files on disk (src/renderer/searchCore.js: matching rules)
src/main/formatter.js        Format Document with Robocop (temporary file outside the project)
src/main/projects.js         create/open projects, setup steps, file tree
src/main/projectTemplate.js  files of a new project
src/main/recentProjects.js   recent projects list
src/main/main.js, preload.js Electron main process and IPC bridge
src/renderer/                UI (vanilla JS): app.js (welcome, projects, explorer), generator.js, tests.js,
                             problems.js (Problems panel)
```

The recorder uses `BrowserContext._startRecording`, a **private** Playwright API. That is why
`playwright-core` is pinned to an exact version: when upgrading it, re-run the tests.

| Recorded action | Browser keyword |
|---|---|
| navigate / open page | `New Page`, `Go To` |
| click, double click, modifiers | `Click`, `Click With Options` |
| fill, press, select, check | `Fill Text`, `Press Keys`, `Select Options By`, `Check Checkbox` |
| assert text / value / checked / visible / snapshot | `Get Text`, `Get Property`, `Get Checkbox State`, `Wait For Elements State`, `Get Aria Snapshot` |
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
