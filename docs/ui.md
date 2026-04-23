# Local UI

Loopi includes a dependency-free local browser UI for setup checks, task configuration, presets, and run monitoring.

The browser bundle is intentionally split by responsibility:

- `apps/ui/public/ui-core.js` for shared UI helpers
- `apps/ui/public/ui-render.js` for screen rendering
- `apps/ui/public/ui-state.js` for draft/config state transitions and derived UI state
- `apps/ui/public/ui-actions.js` for control-plane calls and run-session polling
- `apps/ui/public/ui-bindings.js` for DOM event wiring
- `apps/ui/public/app.js` for composition and bootstrapping

Start it from the project root:

```bash
npm run ui
```

By default, the server binds to `127.0.0.1:4311`.

## Saved Task Safety

The UI treats `shared/task.json` as persisted state, not as a hint to silently fall back to defaults.

If `shared/task.json` is malformed JSON or fails backend validation:

- the UI shows a clear error banner
- the Settings and Task Composer screens are blocked from unsafe save, validate, and run actions
- the raw saved file contents remain visible in the UI so you can inspect what broke
- you must explicitly click `Start New Draft` before replacing the broken file

This is intentional. Loopi will not present an invalid saved task file as if it were a clean draft.

## Optional Arguments

You can pass startup flags directly to the server:

```bash
node src/control-plane/server.js --host 127.0.0.1 --port 3030 --project-root C:\path\to\LoopiDev
```

Available flags:

- `--host`: host to bind to. Default is `127.0.0.1`.
- `--port`: port to bind to. Default is `3030`.
- `--project-root`: project root to use for `shared/`, `config/`, and run data.

## Screens

### Setup

The Setup tab shows local readiness status for supported CLI adapters and configured HTTP providers.

Use it to:

- check whether agent CLIs appear installed
- review adapter-specific docs, install commands, and login commands
- run explicit in-app install helpers for supported npm-distributed CLIs
- launch adapter login commands from Loopi instead of manually opening a terminal first
- test provider connectivity from the current draft, even before saving `shared/task.json`
- confirm the current task is ready before launching a run

Install helpers are always opt-in. Loopi asks for explicit confirmation before running a package install, and it re-checks adapter readiness after install or login commands complete.

Supported built-in install helpers currently cover the npm-distributed CLIs in Loopi metadata. Adapters without a safe built-in installer still show docs plus copyable commands, so manual setup remains available.

### Settings

The Settings tab edits the current task configuration through the same backend validation used by the CLI.

Use it to:

- adjust general task settings such as timeout, scratchpad behavior, and context usage
- check context cache readiness status (not configured, missing, drifted, ready, ready with warnings)
- prepare or re-prepare context directly from the UI
- enable or disable supported agents
- configure HTTP providers
- review or edit the raw JSON when you want the exact persisted shape

If the saved task file is invalid, Settings shows the blocking error state instead of a normal editor. That panel includes the saved file path, the validation error, the raw file contents, and a `Start New Draft` action.

#### Context Status

The status panel works from the current draft config, not just the last saved file.

That means you can change `context.dir`, include/exclude rules, or manifest settings in Settings and check or prepare against that draft before saving.

When a context folder is configured, the Settings screen shows a status indicator with one of these states:

- **Ready** (green): the prepared cache is usable and up to date
- **Ready with warnings** (yellow): usable but some sources were skipped during preparation
- **Drifted** (red): the prepared cache no longer matches the current context inputs (config or source-tree changes)
- **Config mismatch** (red): the configured context rules changed and the cache must be prepared again
- **Not prepared** (red): context is configured but no cache exists yet

The status area also shows:

- the build timestamp
- drift details when the cache is stale
- skipped file counts with reasons when warnings are present

Two actions are available:

- **Prepare Context** (primary when drifted/missing, secondary when ready) triggers a cache build
- **Refresh Status** re-checks the current cache state without rebuilding

If you click **Run Now** while context is missing or stale, the UI blocks launch before starting a live run session, returns you to Settings, and shows the current context status with the next action.

### Task Composer

The Task Composer focuses on the task prompt and mode-specific workflow settings.

Use it to:

- write the task prompt
- select `plan`, `review`, `implement`, or `one-shot`
- choose a use case for modes that require it
- set mode-appropriate loop controls
- assign recommended or explicit model roles
- validate, save, run, or save the current task as a preset

Validation messages are tied to the current draft version. If you validate and then change the draft, the prior success banner is replaced with a warning telling you to validate again before saving or running.

`Run Now` launches a background run session. The UI returns control immediately, switches to the Run Dashboard, and keeps polling while the run is active.

### Run Dashboard

The Run Dashboard combines durable run history from the collaboration store with live in-process run sessions.

Use it to:

- browse stored runs
- watch an active run before the durable task record finishes writing
- inspect task metadata and step timelines
- open stored artifacts
- preview `shared/scratchpad.txt`
- preview `shared/log.json`

If a run has started but its durable record is not available yet, the dashboard shows that as a live warning instead of acting like the run is missing.

If an older run directory is missing or partially damaged, the dashboard keeps the run visible when possible and shows a recoverable warning state instead of dropping it silently.

## Verification

After launching the UI:

1. Open the printed localhost URL in your browser.
2. Confirm the Setup tab loads adapter metadata.
3. For a missing npm-backed CLI, confirm `Install In Loopi` appears, asks for approval, and refreshes the adapter status after completion.
4. For an installed-but-unauthenticated CLI, confirm `Launch Login` appears and refreshes the adapter status after the login flow closes.
5. If `shared/task.json` is invalid, confirm the UI blocks normal task actions and offers `Start New Draft`.
6. Load or edit the current config in Settings.
7. Validate a draft, change one field, and confirm the validation banner becomes stale immediately.
8. Launch a task from Task Composer and confirm the Runs tab shows a live session before completion.
9. Review the resulting run in Run Dashboard.
