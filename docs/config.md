# Configuration Guide

Most users should stay in the CLI flow.

If you prefer manual configuration, or want to inspect and tweak the generated config directly, you can edit `shared/task.json` before running.

## Minimum Example

```json
{
  "mode": "plan",
  "prompt": "Scan Dialectic and look for holes in my logic, sloppy code, or code problems.",
  "agents": ["claude", "codex", "gemini", "opencode"],
  "settings": {
    "timeoutMs": 180000,
    "continueOnError": false,
    "writeScratchpad": true
  }
}
```

## Core Notes

- `mode` currently supports `plan`, `implement`, `review`, and `one-shot`.
- `agents` is an ordered list. The first agent is the origin for that mode's role and the final synthesizer.
- `reviewPrompt` and `synthesisPrompt` are optional top-level prompt overrides for `plan` mode only.
- `customImplementPrompt` is an optional top-level guidance block for `implement` and `one-shot`. It is threaded through initial implement and repair prompts.
- `settings.timeoutMs` applies to each agent step.
- `settings.qualityLoops` is used by `one-shot` mode and defaults to `1`.
- `settings.implementLoops` controls standalone iterative `implement` mode. It falls back to `qualityLoops`, then `1`.
- `settings.implementLoopsPerUnit` controls one-shot implement loops per plan unit. It falls back to `implementLoops`, then `qualityLoops`, then `1`.
- `settings.agentPolicies` controls per-agent write permissions.
- `plan` and `review` use compact machine-readable handoffs internally, with non-fatal fallback to prose when a handoff block is missing or malformed.
- Legacy `task` is still accepted as an alias for `prompt`.

## Implement Guidance

You can add persistent implement-specific guidance with a top-level `customImplementPrompt`:

```json
"customImplementPrompt": "Keep migrations isolated, prefer small reversible edits, and do not widen scope without saying so."
```

Rules:

- Valid only in `mode: "implement"` and `mode: "one-shot"`.
- The value must be a non-empty string.
- This guidance is included in the initial implement prompt and every repair prompt.

## Agent Write Policies

`settings.agentPolicies` is an object keyed by agent name. Each entry can have a `canWrite` boolean:

```json
"agentPolicies": {
  "codex": { "canWrite": true },
  "claude": { "canWrite": false }
}
```

Rules:

- Any supported agent can be configured with `canWrite: true`. By default, all agents start as read-only unless explicitly opted in.
- Write access only applies during `implement` mode, and only to the origin agent for that sub-run.
- `plan` and `review` modes are always read-only, regardless of agent policy.
- Dialectic passes the `canWrite` intent to each agent's CLI. The actual CLI flags used depend on the installed tool.
- A validation warning is emitted when `canWrite: true` is configured, reminding you that the agent will modify repository files directly.

## Agent Options

`settings.agentOptions` is an optional object for specifying per-agent model or effort preferences.

```json
"agentOptions": {
  "codex": { "model": "gpt-5.4", "effort": "medium" },
  "claude": { "model": "opus" },
  "gemini": { "model": "gemini-2.5-flash" }
}
```

Rules:

- Both `model` and `effort` are optional. Omit to use the CLI default.
- Keys must match a CLI adapter that appears either in the top-level `agents` list or in a CLI-backed role assignment.
- When an option cannot be applied, a warning is recorded on the step record and appears in the scratchpad output.

Per-agent support summary:

| Agent | `model` | `effort` |
| --- | --- | --- |
| codex | Applied via `--model` | Applied via `--reasoning-effort` with `low`, `medium`, `high` |
| claude | Applied via `--model` with warnings for unverified strings | Not automatable |
| gemini | Applied via `--model` for supported Gemini values | Not supported |
| kilo | Fixed model only | Not supported |
| qwen | Fixed model only | Not supported |
| opencode | Fixed model only | Not supported |

Unknown keys are rejected. Each `agentOptions.<agent>` object may only contain `model` and `effort`.

## Fallback Downgrades

When an agent's primary invocation fails and a fallback is used, some capabilities may be lost. Dialectic records these as `capabilityDowngrades` on the step record.

| Agent | Fallback | Capabilities dropped |
| --- | --- | --- |
| claude | Minimal fallback | `--permission-mode`, `--model` |
| codex | Minimal fallback | `--sandbox`, `--model`, `--reasoning-effort` |
| qwen | Fallback | `--approval-mode` |

The Codex safe fallback preserves write mode, model, and effort.

## One-Shot Origin Config

In `one-shot` mode, `settings.oneShotOrigins` lets you choose which agent leads each submode:

```json
"settings": {
  "oneShotOrigins": {
    "plan": "claude",
    "implement": "opencode",
    "review": "gemini"
  }
}
```

Rules:

- Only valid in `mode: "one-shot"`.
- Allowed keys are `plan`, `implement`, and `review`.
- Each origin agent must be present in the top-level `agents` list.
- Missing entries fall back to the first agent in `agents`.
- Write access in the implement sub-run follows the implement origin.
- One-shot implement loops run per structured plan unit using `settings.implementLoopsPerUnit`.

See `shared/task.example.json` for a complete example.
