# Configuration Guide

Most users should stay in the CLI flow.

If you prefer manual configuration, or want to inspect and tweak the generated config directly, you can edit `shared/task.json` before running.

Validation happens when Loopi loads the file. If `shared/task.json` is malformed or contains invalid config values, the CLI will fail early and the local UI will show the saved file as invalid instead of replacing it with defaults. In the UI, save, validate, and run actions stay blocked until you either fix the file or explicitly choose `Start New Draft` and replace it.

## Minimum Example

```json
{
  "mode": "plan",
  "prompt": "Scan Loopi and look for holes in my logic, sloppy code, or code problems.",
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
- `useCase` is an optional top-level field for `plan` mode and a required top-level field for `one-shot` mode. It loads a structured use-case config from `config/use-cases/*.json`.
- `reviewPrompt` and `synthesisPrompt` are optional top-level prompt overrides for `plan` mode only.
- `customImplementPrompt` is an optional top-level guidance block for `implement` and `one-shot`. It is threaded through initial implement and repair prompts.
- `settings.timeoutMs` applies to each agent step.
- `settings.planLoops` controls the number of plan-review-synthesis cycles for `plan` mode, and the number of plan cycles within each quality loop for `one-shot` mode. Defaults to `1`, with fallback to `qualityLoops` for backward compatibility.
- `settings.qualityLoops` is used by `one-shot` mode for total outer reruns of the entire sequence. Defaults to `1`.
- `settings.sectionImplementLoops` controls per-section implement-review-repair cycles in one-shot mode. This is the canonical name for this setting. The deprecated alias `implementLoopsPerUnit` is still accepted for backward compatibility. Falls back to `implementLoopsPerUnit` → `implementLoops` → `planLoops` → `qualityLoops` → `1`.
- `settings.implementLoops` controls standalone iterative `implement` mode. It falls back to `qualityLoops`, then `1`.
- `settings.implementLoopsPerUnit` is deprecated. Use `settings.sectionImplementLoops` instead. Still accepted as a fallback alias for backward compatibility.
- `settings.agentPolicies` controls per-agent write permissions.
- `fork` is an optional top-level lineage block for manually forked retries.
- `plan` and `review` use compact machine-readable handoffs internally, with non-fatal fallback to prose when a handoff block is missing or malformed.
- Legacy `task` is still accepted as an alias for `prompt`.

## Fork Lineage

If a task is a manual retry of an earlier run, you can include a top-level `fork` block:

```json
"fork": {
  "forkedFromRunId": "run-2026-04-21T12-34-56-789Z",
  "forkedFromStepId": "implement-4",
  "baseCommit": "abc123def456",
  "reason": "Retry with different reviewer feedback",
  "recordedBy": "manual"
}
```

Rules:

- `fork` is optional.
- `fork.forkedFromRunId` is required when `fork` is present.
- `fork.forkedFromStepId`, `fork.baseCommit`, `fork.reason`, and `fork.recordedBy` are optional.
- If `recordedBy` is omitted, Loopi defaults it to `manual`.

You do not have to write this block by hand. `npm run cli -- fork <runId> [stepId]` will create it for you.
If you provide `stepId`, Loopi requires a persisted `post-step` or `pre-step` snapshot for that exact step and will fail rather than falling back to a run-level snapshot.

See `shared/task.example.json` for `manualForkExample`.

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
- Loopi passes the `canWrite` intent to each agent's CLI. The actual CLI flags used depend on the installed tool.
- For Kilo, write-enabled implement steps run with `kilo run --auto`; read-only steps omit `--auto` and rely on the read-only prompt.
- A validation warning is emitted when `canWrite: true` is configured, reminding you that the agent will modify repository files directly.

## Agent Options

`settings.agentOptions` is an optional object for specifying per-agent runtime preferences. The Settings UI reads the same adapter metadata and renders the fields each installed adapter can support.

```json
"agentOptions": {
  "codex": { "model": "gpt-5.4", "effort": "medium" },
  "claude": { "model": "opus", "effort": "high" },
  "gemini": { "model": "gemini-2.5-flash" },
  "kilo": { "model": "anthropic/claude-sonnet-4-6", "agent": "plan", "effort": "high" }
}
```

Rules:

- All agent options are optional. Omit a field to use the CLI default.
- Keys must match a CLI adapter that appears either in the top-level `agents` list or in a CLI-backed role assignment.
- Nested option keys are derived from the adapter config. This keeps validation strict while allowing adapters such as Kilo or Opencode to expose extra fields like `agent` or `thinking`.
- When an option cannot be applied, a warning is recorded on the step record and appears in the scratchpad output.
- The UX app discovers model lists from local adapter state when available. Kilo and Opencode use their `models` command; Kilo uses verbose model metadata to populate model-specific `effort` values from variants; Codex reads local `config.toml` model and migration hints; Claude reads model-picker options from the installed CLI bundle; unavailable discovery falls back to manual entry.

Per-agent support summary:

| Agent | `model` | `effort` / variants | Extra adapter options |
| --- | --- | --- | --- |
| codex | Applied via `--model` | Applied via `-c model_reasoning_effort="..."` with `none`, `minimal`, `low`, `medium`, `high`, `xhigh` | None |
| claude | Applied via `--model` for discovered CLI model-picker options; discovered `Default` omits `--model` | Applied via `--effort` with `low`, `medium`, `high`, `max` | None |
| gemini | Applied via `--model` for supported Gemini values | Not supported | None |
| kilo | Applied via `--model`; the UX app can discover installed CLI model choices and includes Kilo Auto Frontier/Balanced/Free | `effort` is passed via Kilo's `--variant` flag and populated per discovered model when variants are exposed | `agent`, model-aware `thinking` |
| qwen | Fixed model only | Not supported | None |
| opencode | Applied via `--model`; the UX app can discover installed CLI model choices | Not supported | `agent` |

Unknown keys are rejected. Each `agentOptions.<agent>` object may only contain keys declared by that adapter.

## Fallback Downgrades

When an agent's primary invocation fails and a fallback is used, some capabilities may be lost. Loopi records these as `capabilityDowngrades` on the step record.

| Agent | Fallback | Capabilities dropped |
| --- | --- | --- |
| claude | Minimal fallback | `--permission-mode`, `--model` |
| codex | Minimal fallback | `--sandbox`, `--model`, `-c model_reasoning_effort` |
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
- One-shot implement loops run per structured plan section using `settings.sectionImplementLoops`.

See `shared/task.example.json` for a complete example.

## Audit Outputs

Loopi now records a lightweight audit trail around each run.

The main outputs are:

- `shared/scratchpad.txt`
- `shared/runs.ndjson`
- `shared/tasks/<runId>/task.json`
- `shared/tasks/<runId>/steps.ndjson`
- `shared/tasks/<runId>/artifacts/*.json`
- `shared/tasks/<runId>/patches/*.patch`

Important artifact types:

- `worktree-snapshot`
  - recorded at `run-start`
  - recorded at `pre-step` and `post-step` for write-enabled steps
  - recorded at `run-end`
- `fork-record`
  - recorded when a run starts with a top-level `fork` block

This gives you a durable record of:

- which agent ran which stage
- when the step happened
- what the worktree looked like before and after write-enabled steps
- which patch files were captured for later inspection
- whether a run was explicitly forked from an earlier run or step
