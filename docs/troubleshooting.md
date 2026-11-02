# Troubleshooting

Start by checking which environment failed: the Test Generator uses Keywright's
Playwright installation; test execution uses the selected project's Python and
Browser library. Their browser installations are separate.

Commands below are for **PowerShell**, run from the test project root. They assume
the default `.venv`. If `rfide.json` selects another interpreter, use its path
instead. For an absolute executable path, PowerShell requires `&` before the
quoted path, for example `& "C:\Environments\web-tests\Scripts\python.exe" --version`.

## Starting Keywright from source

Installer releases are on hold. Follow [Run from source](../README.md#run-from-source)
to launch the app. Run `npm ci` after dependency changes and use `npm start`, which
builds the editor before opening Electron. The full development and integration-test
setup is documented in [Contributing](../CONTRIBUTING.md).

## Python or Node.js is not detected during project creation

Keywright probes the tools available on its process `PATH`. On Windows it tries
`py -3`, `python`, then `python3` for Python, and checks Node separately.

```powershell
py -3 --version
node --version
```

The Python probe accepts 3.10 or later. The packages installed into the environment
may have additional version requirements. If a tool was installed while Keywright
was open, restart the app so it inherits the updated `PATH`.

Node is required by the project creator's `rfbrowser init` route. Keywright's
bundled Electron runtime does not satisfy that external Node probe.

## Project setup stopped partway through

The setup view retains the command output and marks later steps as skipped. The
folder is deliberately kept. Run only the missing steps, from that folder:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m Browser.entry init
```

Skip environment creation if `.venv` is already valid. If downloading packages or
browsers fails, inspect the command output for proxy, certificate, network or
package-compatibility errors. Use your organization's approved package and proxy
configuration rather than disabling certificate checks.

If Windows cannot launch Browser's downloaded executables from a deep path, choose
a shorter project location and recreate its virtual environment there. A copied
virtual environment can retain paths from its old location.

## No project virtual environment is found

Opening a project does not create its Python environment. Confirm the default
interpreter exists and can import the required packages:

```powershell
.\.venv\Scripts\python.exe --version
.\.venv\Scripts\python.exe -m pip show robotframework robotframework-browser
.\.venv\Scripts\python.exe -c "import robot, Browser; print('Imports OK')"
```

For a shared or differently named environment, set `python` in `rfide.json` and
reopen the project. See [project configuration](user-guide.md#project-configuration).
Installing packages into a different system Python does not change the project's
selected environment.

## Tests are missing from the Testing panel

1. Check `testsDir` in `rfide.json`. The default is `tests`; set it to `.` for suites
   at the project root, or to the repository's actual suite directory.
2. Check the project's interpreter and imported libraries.
3. Clear the Testing text filter and review include/exclude tag patterns.
4. Use Robot's dry run to separate suite problems from Keywright discovery:

```powershell
.\.venv\Scripts\python.exe -m robot --dryrun --outputdir results tests
```

Replace `tests` with your configured directory. A dry run can import libraries but
does not prove that browser actions or application assertions will pass. Review
**Console output** for errors that occur before normal test events.

## The recorder works but the test browser does not launch

The recorder's successful launch verifies its own browser installation only.
Prepare Browser in the project's selected Python:

```powershell
.\.venv\Scripts\python.exe -m Browser.entry init chromium
```

If the failing test selects Firefox or WebKit, initialize the corresponding browser
as well. Inspect the full Robot error for a missing executable, a missing Node
runtime or a project path that is too long.

## The Test Generator cannot launch a browser

Use the generator's installation action when it reports a missing Playwright
browser. This downloads the browser for Keywright's own Playwright version.

**Google Chrome** and **Microsoft Edge** use the browser installed on the machine.
If that channel is missing, install it or choose a downloadable browser. Running
`rfbrowser init` in a test project does not necessarily install the version used
by the generator.

## A run seems to ignore an edit or a browser option

Tests run saved disk contents. When prompted, choose **Save All and Run** to include
modified suites, resources and Python libraries. **Run Saved Files** deliberately
excludes editor changes and displays a notice in Testing. Resolve any save conflict
before retrying the run. Watch pauses while editor changes remain unsaved.

**Show browser** supplies `${HEADLESS}=False`, and the **Browser** option supplies
`${BROWSER}`. Your `New Browser` call must use those variables. A recorded call such
as `New Browser    chromium    headless=True` keeps its literal values.

An individual-test selection bypasses include/exclude tag filters. Extra Robot
arguments can also change behavior; review them when reproducing a run.

## No trace is available

Check all of the following:

- **Record trace** was enabled before the run.
- The test or setup creates a context explicitly with `New Context`.
- The context has closed. While paused before teardown, its trace may not yet exist.
- The run completed far enough to write the archive; force-stopping can prevent it.
- A later run has not removed or replaced the artifact.
- Extra Robot arguments have not redirected output away from `outputDir`.

A suite-level context can produce a shared suite trace. History does not preserve
old trace archives. See [results and traces](user-guide.md#results-and-traces).

## Completion or diagnostics are missing or stale

Check the Python path shown by the project and the keyword-loading status at the
bottom of the editor. A library that cannot be imported prevents complete keyword
documentation; unknown-keyword diagnostics are deliberately suppressed in that case.

Confirm the library is installed in that interpreter. Saved Python changes inside
the project refresh the keyword index. Each rebuild checks the documented library
source, and failed imports are retried. After installing packages or changing code
outside the watched project, close and reopen the project to force a rebuild.

Variables supplied only through Robot command-line arguments may be reported as
undefined by static analysis. Where appropriate, provide a default in a Variables
section. Dynamic calls and runtime values cannot all be resolved statically.

## Formatting is unavailable

Robocop must be installed in the project environment. Use Keywright's offered
installation action, or install it explicitly:

```powershell
.\.venv\Scripts\python.exe -m pip install robotframework-robocop
.\.venv\Scripts\python.exe -m robocop --version
```

The formatter uses Robocop's `format` command. If an older version or configuration
does not support it, inspect the reported error and use a compatible package
version. Formatting changes the editor buffer; save it afterwards.

## Report or history differs from the result you expected

**Report** and **Log** read the latest files under `outputDir`; they are not snapshots
of a selected history entry. History keeps up to 30 summaries and does not store a
run unless it received a completed test result. A failure before test execution
may therefore be visible in Console output without creating a history entry.

Copy reports, traces and screenshots before another run if you need to retain
that evidence. Use a dedicated `outputDir` and avoid overriding it in Robot arguments.

## "Path is outside the project"

The file path may look relative to the project while a symbolic link or Windows
junction points elsewhere. Keywright checks the actual destination before opening,
saving, creating or replacing project files. Open the destination's own folder to
edit it. Links whose destinations remain inside the opened project are allowed;
broken links need to be repaired before use.

Report and trace requests also stay within their configured output folders after
resolving links. Keep report assets in that output folder if an embedded report
cannot load an asset stored elsewhere.

## Reporting a problem

Include the Keywright version, Windows version, selected Python path, package
versions, reproduction steps, expected result and actual result. Useful package
information can be collected with:

```powershell
.\.venv\Scripts\python.exe --version
.\.venv\Scripts\python.exe -m pip show robotframework robotframework-browser robotframework-robocop
```

Attach a minimal suite or resource where possible. Remove credentials, personal
data and private application details from source, logs, screenshots and traces.
Submit the report to the [issue tracker](https://github.com/silvestrodecaro/keywright/issues).
