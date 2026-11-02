# Existing projects and the Keywright rename

Keywright now uses its product name in project configuration, run history,
preferences and environment variables. Existing project data remains readable.

| Data or interface | Current name | Accepted legacy name |
| --- | --- | --- |
| Project configuration | `keywright.json` | `rfide.json` |
| Run history in the output folder | `.keywright-history.json` | `.rfide-history.json` |
| Preferences | `keywright.*` | `rfide.*` |
| Integration-test Python | `KEYWRIGHT_PYTHON` | `RFIDE_PYTHON` |
| Update feed override | `KEYWRIGHT_UPDATE_URL` | `RFIDE_UPDATE_URL` |

## Project configuration

New projects and the supplied walkthrough use `keywright.json`. An existing
`rfide.json` is read when no `keywright.json` exists. Opening the project does not
rename or rewrite either file.

To adopt the current name, rename the existing configuration to `keywright.json`.
If both files exist, Keywright uses the new one, with defaults for its omitted
properties. It does not merge values from the old file. Invalid JSON in the new
file is reported rather than silently loading the old configuration.

## Run history and preferences

When `.keywright-history.json` does not exist, History reads the older file in
the same output folder. The next completed run writes the new file and carries
over previous summaries, subject to the existing 30-run limit. The old file is
left unchanged. An existing new file, including an empty array, takes precedence.

Preferences are copied to their new keys when first read. Existing new values
take precedence, including empty values. Old keys remain available. If storage
cannot accept the copy, the old value is still used for that read.

This covers sidebar width, lint preference, watches, breakpoints and run options.
Project-specific keys retain the project path. The application name and its
Keywright user-data directory are unchanged. Migration from the earlier
Robot Framework IDE profile remains available for first-time Keywright startup.

## Development interfaces

Use `KEYWRIGHT_*` environment variables in scripts and CI. Legacy aliases remain
accepted for the integration-test interpreter, test hooks, update feed and Robot
listener settings (`PORT`, `SELECT`, `DEBUG`, `BREAKPOINTS`, `PAUSE_ON_FAILURE`).
Explicit modern values take precedence. Unrelated project variables are preserved.

The Python helper is now `keywright_runner.py`; internal callers use
`keywright_runner.Listener` and `keywright_runner.SelectTests`. Scripts that
invoked the old helper filename directly need to use the new filename.
The renderer bridge is `window.keywright`, and application events use `keywright:`.
These internal interfaces are updated together with the application.

The Windows package ID is `io.github.silvestrodecaro.keywright`. This metadata
change does not rename project files or the Keywright profile directory. Installer
releases remain on hold; installer upgrades are separate from this source workflow.
