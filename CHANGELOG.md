# Changelog

Notable changes to Keywright. Each version is a Git tag such as `v0.1.0` that you
run from source; there are no installers yet.

## Unreleased

### Fixed

- A test run ends when Robot exits, even when a process the tests started keeps
  running with Robot's output; the Testing panel used to wait for that process.
- The Testing panel and run history show the open project's tests and runs only,
  also when an earlier request answers after another project opened.
- Closing the project during a recording at the cursor stops the recording, so
  the editor does not stay read-only.
- Opening a project again quickly no longer offers or stores the previous
  project's unsaved-file copies.
- Saving a file no longer rebuilds the Explorer, and reading the project tree no
  longer holds up the rest of Keywright in large projects.
- Closing or changing the project while recovered files load no longer opens them
  in the next project or overwrites its unsaved-file copies.
- The test tree uses the additional Robot arguments of the Run options, so tests
  renamed with `--name` can be run and show their results, and files added with
  `--extension` are listed.
- Editing CSS, HTML, JavaScript and TypeScript files no longer raises errors in the
  editor.

### Changed

- The recorder uses Playwright 1.65.1; run `npm run install-browsers` after updating.
  DOMPurify is 3.4.18 and the Robocop test baseline 9.4.0.

## 0.6.0 - 2026-11-21

### Fixed

- Escape restores keyboard focus to the Explorer after a file change refreshes
  the tree while its context menu is open.
- Starting Keywright a second time with the same profile brings the open window
  to the front. A second instance used to empty the first one's undo copies of
  AI deletions and could overwrite its recovery copies.
- Quitting from the crash dialog, or by any other route, stops running tests,
  browsers, the language worker and project setup processes. Some of them used
  to keep running after Keywright closed.
- Starting a run, the recorder, the AI browser or the MCP server twice at the
  same moment no longer starts two of them. Stop and project changes made while
  one is starting now take effect.
- A Python helper or language worker stuck at a library import is stopped after
  a time limit, and the next request starts a new one. Its error output is shown
  when it stops.
- The window opens even when the MCP server cannot start.
- An AI deletion whose copy could not be made shows why, and deletions made at
  the same time keep separate copies for undo.
- A debug run whose connection to Keywright closes no longer stops forever at
  the next failure, and a malformed debugger command no longer ends debugging.
- Pausing shows a variable whose value cannot be displayed by its type instead
  of skipping the pause.
- Only the run's own Robot process can send events to the Testing panel and
  receive debugger commands.
- Keyword documentation is read for libraries that print when Python exits, and
  for libraries imported by module name from the project folder.
- Text that a library prints while the editor checks a file no longer delays
  the check until it times out.
- A file that is not UTF-8 opens read-only with an explanation. Saving it, or
  replacing text in it from Search, used to replace its accented characters.
- Replace in Files saves each file like the editor does: it skips files changed
  since the search or with unsaved edits, and names them.
- A damaged recovery file, recent projects list, MCP settings file or run
  history is kept as `<name>.corrupt-<time>` instead of being emptied and
  overwritten. A `keywright.json` or `mcp.json` saved with a byte order mark,
  as Notepad does, now reads correctly.
- Saves and settings files retry for a moment when an antivirus scanner holds
  them, and leave no temporary file behind when they fail.
- A section header followed by column names, as in data-driven tests
  (`*** Test Cases ***    Username    Password`), is recognized; the file used
  to lose highlighting and checks.
- Regular expressions in Search accept escapes such as `\-` and `\#`, and `$10`
  in a replacement works as in JavaScript.
- **Add END** places `END` after the `ELSE`, `EXCEPT` and `FINALLY` branches.
- `&` works as AND in tag filters, as in Robot Framework.
- Renaming a keyword no longer changes arguments of unrelated keywords whose name
  contains "keyword", and a file with `[Template]` in a comment keeps its checks.
- `Set Local Variable` counts only in its own test or keyword.
- A rename that fails on one file changes no file, and Go to Definition and
  Peek show a closed file's current content, also after switching projects.
- When the Robot check cannot run, the file says why instead of showing no
  problems.
- Saving a `.robot` file checks that file again in Problems instead of the whole
  project.
- Opening the same file twice quickly opens one tab, breakpoints follow renamed
  files, and tabs inside a renamed folder show their current content.
- Watch mode no longer misses changes made while it looks for affected tests,
  applies tag filters to partial watch runs as it does to full ones, and no
  longer reruns because the tests wrote data files.
- The tab strip is no longer rebuilt on every keystroke.
- The AI browser opens only web pages and files of the open project; other
  local files and browser pages are refused.
- An address such as `localhost:3000` opens as `http://localhost:3000` in the
  recorder and the AI browser.
- Recorded text with no-break or other Unicode spaces is written as escapes, so
  it stays one argument in the generated test.
- Selectors containing an apostrophe in a regular expression (`/it's/`) keep
  their frame boundaries, and text with leading spaces or quotes keeps the
  selector Playwright recorded.
- An AI text check is compared as the generated `Get Text` step will compare it,
  so a check that passes in the AI browser also passes in the test.
- Runs with many tests or log messages no longer keep the window busy: the
  Testing panel receives events in batches, redraws a few times a second and
  appends console output instead of rewriting it.
- The end-to-end recording test runs Robot with the browser cache Keywright
  uses, as the app does; it used to fail when only that cache had Chromium.
- CI fails when a test is skipped or a desktop test passes only on a retry.
- Recording with a Playwright that lacks the recorder API fails with an
  explanation instead of recording nothing, and an action the recorder sends in
  an unknown format is logged instead of disappearing.
- Long runs no longer keep every step and screenshot in memory for AI clients,
  and the Testing panel keeps up to 5,000 log messages per test: failures and
  warnings always, the rest in the Robot log.
- While an AI client works, the MCP status no longer reads every changed file
  and client configuration again after each tool call; and a hidden Search
  panel searches again only when it is shown.
- A `keywright.json` that cannot be read while you edit it shows its error in
  the editor status and the Testing panel instead of leaving them loading.
- Deleting a file that was removed after the menu opened reports it instead of
  failing silently.
- A Robocop configuration added in a test folder applies to the editor's lint
  without reloading the libraries.
- The results folder is left out of file watching and Search however
  `keywright.json` spells it (`./results/`, an absolute path, other case). File
  watching starts again after an error, and long bursts of changes are reported
  at least every 2 seconds.
- Names Windows reserves (`con`, `aux`, `com1`) are refused for new projects and
  files, as they already were for renames.
- A connection file left by a Keywright that crashed is removed at start.
- The stdio bridge answers a last request sent without a final newline.
- An AI edit in a file with Windows line endings keeps them.
- Breakpoints and run options belong to a project folder however its path is
  capitalized on Windows; those saved before are still found.
- Keyword lookups requested while one runs share one new Python run that sees
  files written meanwhile, and a library that
  keeps changing during a lookup no longer keeps Python busy without end.

### Security

- A Python interpreter that `keywright.json` sets outside the project folder is
  used only after you confirm it, once per project. One chosen in Project
  Settings counts as confirmed.
- Robot reports and traces are refused to other host names and to web pages
  (DNS rebinding), and the previous project's folders are no longer served.
- Report and trace frames are sandboxed and get no browser permissions.
- **Test connection** shows the command and asks first when it comes from a
  configuration file inside the project.
- `SECURITY.md` describes what opening a project runs and the MCP threat model.

## 0.5.0 - 2026-11-16

### Added

- **Source Control** in the activity bar. View changed and staged files in a
  Git repository, including when the open project is a subfolder. The status
  bar shows the current branch.
- Review text changes side by side or as a patch. Stage or unstage files and
  individual hunks, discard working changes, and commit or amend from the IDE.
- Browse the commit graph, file history and blame. Create and switch branches,
  manage stashes, inspect merge conflicts, and fetch, pull, push or sync with
  configured Git remotes.
- Run the full Windows regression suite with `npm.cmd run test:regression`.
  It covers desktop flows including Git operations against a local remote,
  Robot runs, debugging, recording and replay.

### Fixed

- Undoing a project search replacement in an open editor preserves the text
  you typed before the replacement.

### Changed

- The recorder uses Playwright 1.65.0. The Python test baseline now uses
  Robot Framework 7.5.1, Browser 21.0.0 and Robocop 9.3.0.

## 0.4.1 - 2026-11-10

### Fixed

- The MCP dialog reported an empty Antigravity `mcp_config.json` as unreadable; it
  now counts as not configured. Files saved with a byte order mark are read too.
- The Antigravity instructions match the current app, where
  **Customizations > Installed > MCP Servers** lists servers and **Settings > MCP
  Tools** only sets permissions.

### Added

- Keywright also checks the open project's Antigravity workspace file,
  `.agents/mcp_config.json`, and reports entries turned off with `"disabled": true`.

## 0.4.0 - 2026-11-10

### Added

- An optional MCP server for AI clients such as Claude Code, Codex,
  Antigravity, Claude Desktop and Cursor. The client can read, write, edit, rename and delete
  project files, search keywords, check files and run tests, with the run shown in
  the Testing panel. Files with unsaved editor changes are left alone, and deletions
  go to the Recycle Bin. **MCP** in the title bar turns it on and shows each client's
  configuration.
- The MCP dialog lists each client with what its own configuration file says
  (configured, missing or needing an update), read without changing it, and the time
  it connected. **Test connection** runs the shown configuration the way the client
  will and lists the tools it receives.
- Test runs started by an AI client return within about 45 seconds and continue
  with `wait_for_run`, so client tool timeouts (60 seconds in Codex by default) do
  not cut long runs short.
- `test_failure_details` gives an AI client the failing keyword with its file, line
  and surrounding source, the test's log and Browser's failure screenshot.
- The AI's own browser. The client reads pages as accessibility snapshots and acts on
  their elements; each action returns the Browser step with the selector the Test
  Generator would choose, and the steps can be returned as a complete test. It can
  go back, go forward and reload, recorded as `Go Back`, `Go Forward` and `Reload`.
- The MCP dialog lists the files an AI client created, edited, renamed or deleted,
  with **Undo** for each change while the file is still as the client left it.

## 0.3.0 - 2026-11-10

### Added

- Explorer context menu for files and folders: open, create a file in that folder,
  rename, delete, copy the absolute or relative path and reveal in the file manager.
  Shift+F10 or the Menu key opens it from the keyboard.
- Rename in place with F2. Open tabs follow the renamed file or folder.
- Delete with the Delete key, after confirmation. Files and folders go to the
  Recycle Bin.
- **New file** has a type selector. It adds `.robot` or `.resource` when the name
  has no extension and suggests `.resource` inside the resources folder.

## 0.2.1 - 2026-11-04

### Changed

- The title bar is now part of the app, in its colors and on every screen. It holds
  the open project's name and path, **Project settings** and **Close project**, which
  replaces the separate project header and gives the editor more room. The window
  buttons remain the system's, so Snap Layouts still work.

## 0.2.0 - 2026-11-04

### Added

- Command palette. **Ctrl+P** opens a project file by name and **Ctrl+Shift+P**
  lists the commands that apply at that moment, with their shortcuts.
- **Project settings** dialog for the tests, resources and results folders and the
  Python interpreter. It checks each field, saves `keywright.json` and reopens the
  project, instead of editing the file by hand and reopening it.
- Local crash reports. When the window stops, Keywright saves a report with versions
  and recent app events and offers to reload; the project then offers its unsaved
  files for recovery. Reports stay on the computer.

### Documentation

- A Code of Conduct, a Discussions link for questions and an email contact for
  security reports.

## 0.1.0 - 2026-11-03

The first Keywright release. It includes Test Generator recording, the Monaco
editor with Robot Framework analysis, test execution with streamed keyword
results, failure investigation with screenshots and traces, the Robot debugger and
local run history.

The sections below list the changes from the earlier Robot Framework IDE source
this repository starts from.

### Added

- **Compare…** in the save conflict dialog shows the disk and editor versions side
  by side. Edit your version to combine both, then save it.
- Recovery of unsaved files after a crash. Reopening the project offers to restore
  the unsaved changes or discard them.
- **Reload libraries** in the status bar reads library documentation again after
  packages are installed or libraries change outside the project folder.
- Guided Windows setup through `setup.bat`. It checks Node.js, npm, Python and Git,
  offers WinGet installation of missing prerequisites after confirmation, prepares
  the included example and records its output under `out/setup/`.
- `setup.bat --check`, `--non-interactive` and `--no-pause` options.
- Shared browser storage in the user cache, so projects in nested folders or paths
  containing spaces find their browsers.
- Launch logs under `out/start/`, including Electron startup and renderer failures.
- The Keywright logo in the setup and start banners. Logs, CI and narrow terminal
  windows show a plain title instead.
- A Verify workflow that runs the test suite, the example's Robot tests, setup from a
  long path containing spaces and the desktop UI tests on Node.js 24 and 26.

### Changed

- Renamed the project to Keywright. Configuration files, environment variables and
  settings use Keywright names; settings from the earlier Robot Framework IDE name
  are not migrated.
- `npm.cmd start` stops instead of downloading a missing Electron executable again,
  and setup stops before reinstalling a runtime whose executable was removed.
- Simplified the setup, first-run and update instructions.
- For contributors: Biome lint, CodeQL analysis and Dependabot updates run on the
  repository, and workflow actions are pinned to commit hashes.

### Fixed

- Links in keyword documentation, Robot logs and traces open in the system browser.
  Previously they could open an unrestricted app window; the app now denies new
  windows and navigation away from its page.

### Removed

- Installer packaging, automatic updates and their dependencies. Installer releases
  are on hold until Keywright has a code-signing solution: unsigned installers and
  updates can be blocked by antivirus software on managed Windows devices. The
  packaging toolchain also needs a new [dependency review](docs/dependency-review.md).

### Documentation

- Recovery steps for the Microsoft Defender detection of Electron 45.2.1, which
  Microsoft confirmed as a false positive on 2026-11-02.
