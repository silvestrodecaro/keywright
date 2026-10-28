# User guide

- [Projects](#projects)
- [Editor](#editor)
- [Test Generator](#test-generator)
- [Running tests](#running-tests)
- [Debugging](#debugging)
- [Updates](#updates)

## Projects

The IDE works like VS Code: it is installed once and opens any number of project folders. The welcome screen
offers a new project, an existing folder or one of the recent projects.

A new project looks like this:

```
<name>/
  tests/example.robot        example suite
  resources/common.resource  Library Browser and an "Open Test Browser" keyword
  requirements.txt           robotframework, robotframework-browser, robotframework-robocop
  rfide.json                 IDE settings: tests, resources and results folders, Python
  .gitignore, README.md
```

Creating it runs a few optional steps, with their output shown live: a `.venv` with
`pip install -r requirements.txt` (Python 3.10+), `rfbrowser init` (Node.js) and `git init` with a first
commit. If a step fails, the folder is kept and can still be opened.

Any folder can be opened; `rfide.json` is optional. The list of recent projects is kept in the IDE's data
folder, not in the projects.

On Windows, the browsers installed by the Browser library live deep inside `.venv`, so project paths are
limited to about 85 characters.

## Editor

`.robot` and `.resource` files open in [Monaco](https://microsoft.github.io/monaco-editor/).

### Writing

- Completion (Ctrl+Space) for the keywords of the libraries the project imports (read with `libdoc` in the
  project's Python) and of the project itself, with placeholders for the required arguments, plus snippets
  for FOR, IF, TRY and the other blocks.
- Keyword documentation on hover.
- Shift+Alt+F formats the file with Robocop (the formatter that used to be Robotidy), using the project's
  `robocop.toml` or `[tool.robocop]` in `pyproject.toml`. If Robocop is missing, the editor offers to
  install it in the `.venv`.
- Ctrl+S saves; tabs with unsaved changes show ● and ask before closing.

### Navigating

- Ctrl+click or F12 on a keyword jumps to its definition.
- On a variable, it jumps to where the variable is set: `[Arguments]`, assignments, `FOR`, `VAR`,
  `EXCEPT ... AS`, the `*** Variables ***` section, `Set Test/Suite/Global Variable`, and imported resource
  and variable files (Python and YAML). Hovering shows where the value comes from.
- On the path of a `Resource`, `Variables` or `Library` import, it opens the file. `${CURDIR}` and `${/}` are
  understood.
- Ctrl+Shift+O shows the outline of the file.
- Shift+F12 lists the references of a keyword (library keywords included) or a variable.

### Refactoring

F2 renames a keyword of the project or a variable everywhere it is used:

- keyword calls keep their BDD (`Given`, `When`...) and `resource.` prefixes, and calls in setups, teardowns,
  `[Template]` and `Run Keyword`-style keywords are included;
- variables follow Robot's scoping: a local variable only inside its test or keyword, a suite variable also
  in the files that import it (unless they define their own), including the `$name` form in IF/WHILE
  conditions and in `Evaluate`.

Open files get the changes as unsaved edits (one Ctrl+Z undoes them); other files are saved. Library
keywords, embedded arguments and variable files are not renamed.

Ctrl+. (or the light bulb) offers quick fixes:

- for an unknown keyword, similar names, or *Create keyword* in the file or in an imported resource, with
  `[Arguments]` taken from the call;
- for an undefined variable, similar names, or *Define in the Variables section*;
- *Add END* for an unclosed FOR, IF, WHILE or TRY;
- for a Robocop finding, a `# robocop: off=<rule>` comment on the line or for the whole file.

### Problems

The editor checks files while you type:

- syntax errors, from Robot's own parser (missing `END`, unknown settings, invalid sections...);
- unknown keywords (skipped when a library of the project cannot be imported);
- wrong arguments, with Robot's own messages: missing or extra arguments, named-argument syntax,
  positional after named, unexpected named arguments. Calls using `@{list}` or `&{dict}`, embedded arguments
  and ambiguous names are not checked;
- undefined variables. Built-in and environment variables, inline Python (`${{ }}`) and variables set at run
  time anywhere in the project are accepted. In `.resource` files, the variables of the suites that import
  them are accepted too. Variables only passed with `--variable` are reported: give them a default in a
  Variables section;
- Robocop's style rules (naming, unused variables, missing documentation...), shown as information.

F8 jumps to the next problem. The **Problems** tab in the sidebar lists the problems of every file in the
project, and has a switch to hide Robocop's findings.

### Search

Ctrl+Shift+F searches all the project's files, with match case, whole word, regular expressions and
"files to include" globs (`*.robot, tests/`). `.venv`, `.git`, the results folder and binary files are
skipped. With a replacement, results show a preview (`$1` for regex groups) and can be replaced one at a
time, per file or all at once.

## Test Generator

Type a URL, pick the browser and the viewport, and press **Record**. Interact with the page; the toolbar
injected in it adds assertions (visible, text, value, aria snapshot). Steps can be removed from the list on the
left. Copy the result or save it, by default in the `tests` folder.

| Recorded action | Browser keyword |
|---|---|
| open page, navigate | `New Page`, `Go To` |
| click, double click, with modifiers | `Click`, `Click With Options` |
| fill, press, select, check | `Fill Text`, `Press Keys`, `Select Options By`, `Check Checkbox` |
| assert text, value, checked, visible, snapshot | `Get Text`, `Get Property`, `Get Checkbox State`, `Wait For Elements State`, `Get Aria Snapshot` |
| popup, dialog, download | `Switch Page`, `Handle Future Dialogs`, `Promise To Wait For Download` |

**Pick locator** shows the Browser selector of the element you click, e.g. `role=button[name="Sign in"i]`.
While recording it uses the recorded browser; otherwise it opens one at the URL above.

The same two buttons sit at the top of every `.robot` and `.resource` tab:

- **Pick locator** inserts the selector at the cursor;
- **Record at cursor** writes the recorded steps into the file as you go, indented like the surrounding code.
  It starts with `New Page`, so the test is expected to open the browser and context itself. One Ctrl+Z
  removes the whole recording.

The first time, the Test Generator offers an *Install chromium* button: it downloads the browser it records
with (no Node.js needed). For Firefox and WebKit run
`npx playwright-core install firefox webkit`; Chrome and Edge use the browsers already on the machine.

## Running tests

The **Testing** tab of the sidebar lists the suites and tests of the `tests` folder. Run everything, a suite or
one test (▶ on hover). With a filter in the search box, *Run all* runs only what is shown. **Stop** ends Robot
and the browsers it started.

In the editor, ▶ next to each test (and next to `*** Test Cases ***`) runs it, and then shows the last result.
Unsaved changes are saved first.

### Results

The **Test Results** tab follows the selected test as it runs: status, error, failure screenshots and the tree
of executed keywords with timings and log messages. Suite setups and teardowns appear before and after the
test's own steps. *Go to source* opens the test, *Open log* opens Robot's `log.html` at the test.
The **Report** and **Log** views show Robot's own files from the last run.

**History** keeps the last 30 runs of the project (in `results/.rfide-history.json`). For each run it lists what
changed since the previous one: new failures, fixed tests, tests still failing, slower tests and new tests.

### Options

- *Show browser* runs with `--variable HEADLESS:False`, which the project template passes to `New Browser`.
- *Record trace* (on by default) records a Playwright trace for every context created with `New Context`.
  The **Trace** button opens it inside the IDE. A context created in a suite setup gives one trace for the whole
  suite; contexts created implicitly by `New Page` are not traced.
- *Run options* (kept per project): include and exclude tag patterns (`smoke`, `fastANDui`, `reg*`, `NOTslow`),
  the browser (`--variable BROWSER:...`), dry run, and any other Robot argument. Tag filters do not apply when
  running a single test.

### Watch mode

◉ on a test or a suite (or *Watch* for everything) runs it again when files change, in the IDE or outside it.
A changed suite re-runs its own watched tests; any other change (`.resource`, `.py`, variable files) re-runs
all watched tests. Changes made during a run are queued.

## Debugging

Click left of the line numbers (or press F9) to set a breakpoint, then tick **Debug** in the Testing tab and run.
When a test stops:

- the line is highlighted in the editor;
- the Testing tab shows the call stack and the variables by scope (local, test, suite, global);
- Continue (F5), Step Over (F10), Step Into (F11), Step Out (Shift+F11), Pause and Stop are in the panel.

Right-click a breakpoint to give it a condition, written like an IF: `$i == 5`, `len($items) > 3`.

*Stop on failure* (on by default) pauses where a keyword fails, before teardowns run, so the page is still open.
Failures that are expected, inside TRY, `Run Keyword And Ignore Error`, `Wait Until Keyword Succeeds` and similar,
are skipped.

While paused, the *Watch* box evaluates a variable (`${user}[name]`), a Python expression (`$count + 1`) or a
keyword call (`Get Text    h1`). Pin a result with 👁 to evaluate it again at every pause. Pinned watches never
run keywords.

Breakpoints are kept per project. Changes to them during a run apply immediately, on the saved file.

## Updates

The installed IDE checks the [GitHub releases](https://github.com/silvestrodecaro/robot-ide/releases) a few
seconds after it starts, and again with *Check for updates* on the welcome screen. A banner offers to download
the new version, then to restart and install it; unsaved files are handled first. A downloaded update is also
installed the next time the IDE is closed.
