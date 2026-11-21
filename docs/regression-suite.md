# Keywright regression suite

Run `npm.cmd run test:regression` from the repository root after setting up
the [development and test environment](../CONTRIBUTING.md#tests). Use a Windows
desktop session with Git, Electron, the test Python environment and Chromium for
both Playwright and the Browser library. `KEYWRIGHT_PYTHON` selects an alternate
test interpreter. The suite uses Keywright's default shared browser
cache unless `PLAYWRIGHT_BROWSERS_PATH` is set.

## Automated checks

| Feature | Desktop checks | Component and integration checks |
| --- | --- | --- |
| Setup and startup | Welcome page, startup project argument, native launcher visibility, preload and page-load errors, window controls | [Setup](../test/setup.test.js), [launcher](../test/start.test.js), [terminal output](../test/terminal.test.js), [editor build](../test/editorBuild.test.js) |
| Projects and Explorer | Create with validation, open and remove recent entries, edit project settings, create and rename files, confirm or cancel deletion | [Project lifecycle and saves](../test/projects.test.js), [configuration](../test/projectSettings.test.js), [watcher](../test/projectWatcher.test.js), [tree navigation](../test/treeNavigation.test.js) |
| Workspace and recovery | Reload after a crash, restore or discard unsaved files, compare disk and buffer after a save conflict, open files through the command palette | [File state and save races](../test/workspaceFiles.test.js), [recovery storage](../test/recoveryStore.test.js), [crash reports](../test/crashReports.test.js), [command matching](../test/paletteCore.test.js) |
| Editor and project search | Live diagnostics, completion, formatting, library refresh, go to definition, rename across buffers, regex previews, replace across disk and buffers, undo | [Robot syntax](../test/robotSyntax.test.js), [arguments](../test/argumentCheck.test.js), [keyword index](../test/keywordIndex.test.js), [quick fixes](../test/quickFix.test.js), [navigation](../test/navigation.test.js), [rename](../test/rename.test.js), [search](../test/searchCore.test.js), [formatter](../test/formatter.test.js), [language worker](../test/languageWorker.test.js) |
| Source Control | Init, stage and unstage, review patch and Monaco diffs, commit and recover from an index lock, view history, create or switch branches, stage a hunk, discard, save, apply and drop a stash, publish, push, fetch and pull against a temporary local remote | [Git operations](../test/sourceControl.test.js), including merges, conflicts, amend, blame and project scoping |
| Test Generator | Record against the local demo, rename and save generated Robot code, replay it through Testing, clear the recording, insert steps at the editor cursor and undo the recording | [Recorder lifecycle](../test/recorder.test.js), [locator picking](../test/pickLocator.test.js), [source generation](../test/generator.test.js), [recording and Browser replay](../test/e2e.test.js) |
| Robot execution | Run all, a visible subset or one test, filter by tag, dry run, cancel or save dirty edits before running, stop a live run, pause and resume watch on save | [Runner and discovery](../test/runner.test.js), [tag expressions](../test/tagPatterns.test.js), [watch selection](../test/watchPlan.test.js), [run preparation](../test/workspaceFiles.test.js) |
| Results and debugging | Check failure details and screenshots, navigate to the failed source, open trace, report and log, compare failed and fixed runs, hit a breakpoint, evaluate and watch a value, step and continue | [Run history](../test/runHistory.test.js), [trace serving](../test/traceServer.test.js), [debugger](../test/debugger.test.js) |
| MCP | Connect through the stdio bridge, drive the local demo in the agent's browser, write and run a Robot test, undo file changes and disconnect | [Server](../test/mcpServer.test.js), [client configuration](../test/mcpClients.test.js), [file and run tools](../test/mcpTools.test.js), [undo](../test/mcpChanges.test.js), [agent browser](../test/mcpBrowser.test.js) |

For a focused run, pass a file to `npm.cmd run test:ui -- test/ui/editor.spec.js`
or to `node --test test/runner.test.js`. For failures, open the report with
`npm.cmd exec -- playwright show-report out/ui-report`. Attachments retain the
window screenshot, Playwright trace, Electron log and any Robot results available
for the failed test. Desktop fixtures use temporary projects and profiles. The
[Verify workflow](../.github/workflows/verify.yml) also runs the example from
the Robot CLI and performs guided setup from a long Windows path.

The suite fails when a test is skipped, and when a desktop test passes only on a
retry. `--node-only` and `--desktop-only` run one layer; the Verify workflow runs
them as separate steps, so a missing Python, Git or browser on the runner fails
the job instead of skipping tests. Process lifecycle, JSON persistence, search,
helper timeouts and event batching have their own files:
[processes](../test/processes.test.js), [JSON files](../test/jsonFile.test.js),
[project search](../test/projectSearch.test.js),
[Python helper](../test/pythonHelper.test.js) and
[event batches](../test/eventBatch.test.js).

## Manual checks

| Scenario | What to verify |
| --- | --- |
| Windows display and keyboard | At the minimum window size and at the display scales in use, resize the sidebar and move through the title bar, tabs, Explorer and dialogs with the keyboard. Check visible focus, button labels, clipping and dialog placement. |
| Native desktop actions | In a disposable project, pick and cancel folders, save and cancel an export, copy generated code or a locator into another app, reveal a file and restore an item from the Recycle Bin. Check the selected path and the contents at each destination. |
| Browser choices | For each available browser beyond Chromium, start a recording at the same local page, pick the submit button, record a form submission and replay the generated Robot file. Check the browser and viewport selected in the generated code. |
| Fresh dependencies | In a disposable Windows environment, use the project wizard to create a Python environment and install Browser, trigger the missing-browser or missing-Robocop recovery in the IDE, and retry the operation. Check setup progress and the final result. |
| External Git and MCP clients | With a disposable remote and client configuration, verify authentication, error messages and subsequent successful use. The automated tests use a local Git remote and exercise the MCP protocol and configuration without starting each supported third-party app. |

When adding a capability, link its regression test here. Assert the visible
result or the persisted data at the boundary affected by the change. Use a
temporary fixture and assert a failure or recovery path when the feature has one.
