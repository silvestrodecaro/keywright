# Changelog

Notable changes to Keywright. Each version is a Git tag such as `v0.1.0` that you
run from source; there are no installers yet.

## Unreleased

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
