# CLI Guide

The CLI is the primary way to use Dialectic.

## Beginner CLI

Use the wrapper CLI when you want the normal Dialectic workflow without editing JSON by hand:

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
- `new --advanced` launches the opt-in advanced wizard for users who want a few extra configuration options without editing JSON directly.
- The beginner commands intentionally write minimal configs so the generated `shared/task.json` stays readable if you later open or edit it by hand.
- `run` executes the current `shared/task.json` without reopening the wizard.
- `open` shows the scratchpad path and prints its contents when available.
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

## Troubleshooting

- If an agent is installed but not detected, set the matching `DIALECTIC_*` override.
- To find an installed CLI path on Windows, use `where.exe claude`, `where.exe codex`, `where.exe gemini`, and so on.
- On macOS or Linux, use `which claude`, `which codex`, `which gemini`, and so on.
- Advanced or developer override: set `DIALECTIC_PROJECT_ROOT` to point the CLI at a different project root.

## Direct Task-File Execution

If you intentionally want the manual task-file flow, you can still run the current `shared/task.json` directly:

```bash
npm start
```

That path is supported, but it is the advanced or manual path rather than the recommended starting point.
