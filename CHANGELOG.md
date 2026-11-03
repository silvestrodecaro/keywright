# Changelog

Notable changes to Keywright. Keywright runs from source and has no published
releases yet; the version in `package.json` changes when a source version is tagged.

## Unreleased

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

### Removed

- Installer packaging, automatic updates and their dependencies. Installer releases
  are on hold until the packaging toolchain passes the dependency audit; see the
  [dependency review](docs/dependency-review.md).

### Documentation

- Recovery steps for the Microsoft Defender detection of Electron 45.2.1, which
  Microsoft confirmed as a false positive on 2026-11-02.

## 0.2.0 - project baseline

The source baseline from which this repository starts: Test Generator recording,
the Monaco editor with Robot Framework analysis, test execution with streamed
keyword results, failure investigation with screenshots and traces, the Robot
debugger and local run history.
