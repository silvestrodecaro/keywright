# Development

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

The installer is not code-signed.

## Publishing a release

Installed copies read updates from this repository's GitHub releases.

1. Raise `version` in `package.json`. The IDE only offers versions higher than its own.
2. Commit, push, and push the tag: `git tag v<version>` and `git push origin v<version>`.
3. Create the GitHub release for the tag first (with the release notes). Left to itself, `npm run release`
   can create two releases for the same tag, one of them with only the `.blockmap`.
4. Either run `npm run release` with `GH_TOKEN` set to a token with *Contents: read and write* on the
   repository, or run `npm run dist` and attach the three files from `release/` to a GitHub release for the tag:
   the `.exe`, its `.blockmap` and `latest.yml`.

`latest.yml` is what installed copies look for; without it they don't see the new version. Setting
`RFIDE_UPDATE_URL` makes the IDE read updates from another folder served over http(s), e.g. a mirror.
