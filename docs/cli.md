# CLI Guide

The CLI is the primary way to use Loopi.

If you prefer a browser-based control plane for setup, settings, task composition, and run monitoring, you can launch the local UI instead:

```bash
npm run ui
```

The UI runs locally on `http://127.0.0.1:4311` by default and uses the same validated backend services as the CLI.
It also surfaces invalid saved task files explicitly instead of masking them with defaults, and its Runs tab shows live background sessions while a task is still running.

## Beginner CLI

Use the wrapper CLI when you want the normal Loopi workflow without editing JSON by hand:

```bash
npm run cli -- help
```

Common commands:

```bash
npm run cli -- plan
npm run cli -- review
npm run cli -- implement
npm run cli -- oneshot
npm run cli -- new --advanced
npm run cli -- doctor
npm run cli -- run
npm run cli -- open
npm run cli -- fork <runId> [stepId] [--reason "text"] [--run]
npm run cli -- compare <runIdA> <runIdB>
```

Shortcut scripts are also available if you want to skip the `npm run ... --` form:

```bash
npm run cli:plan
npm run cli:review
npm run cli:implement
npm run cli:oneshot
```

Notes:

- The `--` is required so `npm run` forwards the command name to the CLI.
- `plan`, `review`, `implement`, and `oneshot` launch a short interactive wizard, write `shared/task.json`, and can immediately run the task for you.
- The wizard prompts for `useCase` in `plan` and `one-shot` modes, allowing you to select from available use-case templates in `config/use-cases/*.json`.
- The wizard prompts for loop settings based on mode:
  - `plan`: prompts for `Plan loops` (plan-review-synthesis cycles)
  - `one-shot`: prompts for `Use case`, `Plan loops`, `Section implementation loops`, and `Quality loops`
  - `implement`: prompts for `Implementation loops` (implement-review-repair cycles)
- `new --advanced` launches the opt-in advanced wizard for users who want a few extra configuration options without editing JSON directly.
- The beginner commands intentionally write minimal configs so the generated `shared/task.json` stays readable if you later open or edit it by hand.
- `run` executes the current `shared/task.json` without reopening the wizard.
- `open` shows the scratchpad path and prints its contents when available.
- `fork <runId> [stepId] [--reason "text"]` rebuilds `shared/task.json` from a prior run's stored task record and adds a top-level `fork` block so the next run records manual lineage without hand-editing JSON.
- If you include `stepId`, Loopi requires a persisted `post-step` or `pre-step` snapshot for that exact step and will fail instead of silently falling back to a run-level snapshot.
- `fork ... --run` writes the forked task and immediately executes it.
- `compare <runIdA> <runIdB>` prints a compact comparison of the two runs' representative recorded snapshots and patch-file paths.
- `doctor` checks the current task file, validates it, and verifies the selected CLI agents look available.

## Presets

Preset commands:

```bash
npm run cli -- preset list
npm run cli -- preset save my-plan
npm run cli -- preset use my-plan
```

- Presets are stored under `shared/presets/`.
- `preset save <name>` copies the current validated `shared/task.json` into a named preset.
- `preset use <name>` copies that preset back into `shared/task.json` so you can rerun it with `npm run cli -- run`.

## Recommended Starter Workflow

1. Run `npm run cli -- doctor`.
2. Run `npm run cli -- plan` or `npm run cli:plan`.
3. Choose whether to run immediately or leave the generated `shared/task.json` for later.
4. Review the result in `shared/scratchpad.txt` after the task runs.
5. Save a setup you like with `npm run cli -- preset save my-plan`.

## Audit Helpers

The audit-trail commands are meant to stay lightweight and human-centered.

### Create a forked retry

```bash
npm run cli -- fork run-2026-04-21T12-34-56-789Z implement-4 --reason "Retry with tighter scope"
```

This command:

- reads the stored task config from `shared/tasks/<runId>/task.json`
- writes a new `shared/task.json` using that config as the base
- adds a top-level `fork` block so the next run writes a `fork-record` artifact

If you want to run it immediately:

```bash
npm run cli -- fork run-2026-04-21T12-34-56-789Z implement-4 --reason "Retry with tighter scope" --run
```

### Compare two runs

```bash
npm run cli -- compare run-2026-04-21T12-34-56-789Z run-2026-04-22T08-10-00-000Z
```

The current compare helper is intentionally simple. It prints:

- each run's mode and agents
- the representative recorded snapshot for each run
- the patch file path captured for that run

That is enough to quickly answer "which run should I inspect?" before opening the patch files directly.

## Troubleshooting

- If an agent is installed but not detected, set the matching `LOOPI_*` override.
- To find an installed CLI path on Windows, use `where.exe claude`, `where.exe codex`, `where.exe gemini`, and so on.
- On macOS or Linux, use `which claude`, `which codex`, `which gemini`, and so on.
- Advanced or developer override: set `LOOPI_PROJECT_ROOT` to point the CLI at a different project root.

## Direct Task-File Execution

If you intentionally want the manual task-file flow, you can still run the current `shared/task.json` directly:

```bash
npm start
```

That path is supported, but it is the advanced or manual path rather than the recommended starting point.
