# Contributing

Bug reports and ideas are welcome in the [issues](https://github.com/silvestrodecaro/robotframework-ide/issues). For a
change of more than a few lines, open an issue first so we can agree on the approach.

## Running from source

```sh
npm install
npm run install-browsers     # Chromium for the recorder
npm start                    # builds the editor bundle, then starts Electron
```

`npm start -- <folder>` opens a project directly. `npm run build:watch` rebuilds the editor bundle on change.

## Tests

```sh
npm test
```

Most tests are plain Node tests. The ones that run Robot Framework (the end-to-end recorder test, the test
runner, the debugger, the language worker) need a Python with Robot Framework and Browser, and are skipped
without one:

```sh
python -m venv .venv
.venv/Scripts/pip install robotframework robotframework-browser robotframework-robocop
.venv/Scripts/rfbrowser init chromium
```

`RFIDE_PYTHON` can point to another Python instead.

## Layout

```
src/main/            Electron main process
  main.js, preload.js    window, IPC and the window.rfide bridge
  recorder.js            Playwright with its recorder enabled
  testRunner.js          test discovery and robot runs
  keywordIndex.js        keywords for completion and hover (project index + cached libdoc)
  languageWorker.js      long-lived Python process for syntax checks and Robocop lint
  traceServer.js         Playwright's trace viewer and Robot's output files on 127.0.0.1
  projectWatcher.js      file changes in the open project
  projects.js            create and open projects, setup steps, file tree
  formatter.js           Format Document with Robocop
  runHistory.js          results/.rfide-history.json
  updater.js             updates from GitHub Releases
src/generator/       recorded actions -> Browser keywords (pure functions)
src/python/
  rfide_runner.py        runs in the project's Python: discovery, libdoc, listener, debugger, lint
src/renderer/        UI, plain JavaScript
  editor/                Monaco integration, bundled by scripts/build.mjs into src/renderer/dist
    robotSyntax.js         line analysis shared by highlighting and completion
    argumentCheck.js       mirrors Robot's argument resolver
    navigation.js          outline, variable definitions, undefined variables
    rename.js, quickFix.js
  app.js, generator.js, tests.js, problems.js, search.js, history.js
```

The recorder relies on `BrowserContext._startRecording`, a private Playwright API, so `playwright-core` is
pinned to an exact version. Run the tests after upgrading it.

## Installer

```sh
npm run dist     # release/RobotFrameworkIDE-Setup-<version>.exe (NSIS, per user)
npm run pack     # release/win-unpacked/, to try the packaged app without installing
```

