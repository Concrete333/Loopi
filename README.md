# Dialectic

A Windows-first orchestration layer that lets multiple AI coding agents collaborate in structured plan, review, implement, and one-shot loops instead of isolated one-off prompts.

## What It Does

Dialectic coordinates supported terminal agents and OpenAI-compatible HTTP providers through explicit multi-step flows. It writes a normal `shared/task.json`, validates it, runs the orchestrator, and stores human-readable output in `shared/scratchpad.txt` plus structured runtime artifacts under `shared/tasks/`.

The goal is a repo you can clone, configure, and use without editing source code. If you want the easiest path in, use the CLI wizard instead of hand-writing JSON.

## Requirements

- Windows is the primary platform today. The CLI and test workflow are exercised most heavily in Windows PowerShell.
- Node.js 20 or newer.
- At least one supported AI coding CLI installed and authenticated.
- A local Git repository for the project you want the agents to work on.

## Install

```powershell
git clone <your-repo-url>
cd Dialectic
npm install
```

You only need to install the agent CLIs you actually want to use. Starting with one is completely fine.

## Supported Agents

| Agent | Install / docs | Auth / setup | Dialectic override |
| --- | --- | --- | --- |
| Claude Code | [Anthropic setup docs](https://docs.anthropic.com/en/docs/claude-code/getting-started) | Run `claude`, then follow the Anthropic / Claude login flow | `DIALECTIC_CLAUDE_PATH` |
| Codex CLI | [OpenAI Codex CLI getting started](https://help.openai.com/en/articles/11096431-openai-codex-ci-getting-started) | Run `codex auth login` or sign in when prompted | `DIALECTIC_CODEX_JS` |
| Gemini CLI | [Gemini CLI quickstart](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/index.md) | Run `gemini`, then choose your Google auth flow | `DIALECTIC_GEMINI_JS` |
| Kilo Code CLI | [Kilo Code CLI](https://kilocode.ai/cli) | Run `kilo auth login` and configure the provider you want to use | `DIALECTIC_KILO_PATH` |
| Qwen Code | [Qwen Code docs](https://qwenlm.github.io/qwen-code-docs/en/users/overview/) | Run `qwen`, then complete the Qwen OAuth / account setup | `DIALECTIC_QWEN_JS` |
| OpenCode | [OpenCode docs](https://opencode.ai/docs/) | Run `opencode`, then use `/connect` or `opencode auth login` to configure a provider | `DIALECTIC_OPENCODE_PATH` |

## First Run

After you install at least one agent CLI, validate your setup:

```powershell
npm run cli -- doctor
```

Then generate your first task interactively:

```powershell
npm run cli -- plan
```

Typical flow:

```text
What do you want the agents to do: Plan a small calculator app
Supported agents: 1) claude, 2) codex, 3) gemini, 4) kilo, 5) qwen, 6) opencode
Enter agent names or numbers separated by commas.
Which agents should help: 1
Run now? [Y/n]: y
Task written. Starting run...
```

If you answer `n` to `Run now?`, Dialectic writes `shared/task.json` and prints the command to run it later.

## Troubleshooting

- Run `npm run cli -- doctor` first. It validates `shared/task.json` and checks that the selected CLI agents appear usable.
- If an agent is installed but not detected, set the matching `DIALECTIC_*` override:
  - `DIALECTIC_CLAUDE_PATH`
  - `DIALECTIC_CODEX_JS`
  - `DIALECTIC_GEMINI_JS`
  - `DIALECTIC_KILO_PATH`
  - `DIALECTIC_QWEN_JS`
  - `DIALECTIC_OPENCODE_PATH`
- To find an installed CLI path on Windows, use `where.exe claude`, `where.exe codex`, `where.exe gemini`, and so on.
- On macOS or Linux, use `which claude`, `which codex`, `which gemini`, and so on.
- Advanced/developer override: set `DIALECTIC_PROJECT_ROOT` to point the CLI at a different project root.
- Dialectic uses the `DIALECTIC_*` environment variable prefix for CLI overrides and project-root selection.

## Modes

`plan`, `implement`, `review`, and `one-shot` are implemented end to end.

Flow summary:

1. `plan`: initial plan -> review(s) -> synthesis
2. `implement`: implement -> review(s) -> repair
3. `review`: initial review -> parallel reviews -> synthesis
4. `one-shot`: plan -> per-unit implement/review -> replan until the requested loop count is exhausted

For `qualityLoops = 3`, one-shot becomes:

`plan -> implement -> review -> plan -> implement -> review -> plan -> implement`

## Task File

If you prefer manual configuration, you can still edit `shared/task.json` directly before running:

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

Notes:

- `mode` currently supports `plan`, `implement`, `review`, and `one-shot`.
- `agents` is an ordered list. The first agent is the origin for that mode's role and the final synthesizer.
- `reviewPrompt` and `synthesisPrompt` are optional top-level prompt overrides for `plan` mode only.
- `customImplementPrompt` is an optional top-level guidance block for `implement` and `one-shot`. It is threaded through initial implement and repair prompts.
- `settings.timeoutMs` applies to each agent step.
- `settings.qualityLoops` is used by `one-shot` mode and defaults to `1`.
- `settings.implementLoops` controls standalone iterative `implement` mode. It falls back to `qualityLoops`, then `1`.
- `settings.implementLoopsPerUnit` controls one-shot implement loops per plan unit. It falls back to `implementLoops`, then `qualityLoops`, then `1`.
- `settings.agentPolicies` controls per-agent write permissions (see below). All agents default to read-only unless explicitly opted in.
- `plan` and `review` now use compact machine-readable handoffs internally, with non-fatal fallback to prose when a handoff block is missing or malformed.
- Legacy `task` is still accepted as an alias for `prompt`.

### Implement Guidance

You can add persistent implement-specific guidance with a top-level `customImplementPrompt`:

```json
"customImplementPrompt": "Keep migrations isolated, prefer small reversible edits, and do not widen scope without saying so."
```

Rules:

- Valid only in `mode: "implement"` and `mode: "one-shot"`.
- The value must be a non-empty string.
- This guidance is included in the initial implement prompt and every repair prompt.

### Agent Write Policies

`settings.agentPolicies` is an object keyed by agent name. Each entry can have a `canWrite` boolean:

```json
"agentPolicies": {
  "codex": { "canWrite": true },
  "claude": { "canWrite": false }
}
```

Rules:

- Any supported agent can be configured with `canWrite: true`. By default, all agents start as read-only unless explicitly opted in.
- Write access only applies during `implement` mode, and only to the **origin agent** (the first agent in the effective agent list for that sub-run). Reviewers in the same implement sub-run are always read-only, even if their policy says `canWrite: true`.
- `plan` and `review` modes are always read-only, regardless of agent policy.
- Dialectic passes the `canWrite` intent to each agent's CLI. The actual CLI flags used depend on the installed tool — see the adapter source for details.
- A validation warning is emitted when `canWrite: true` is configured, reminding you that the agent will modify repository files directly.

**Warning:** Enabling `canWrite: true` allows that agent to modify repository files directly during implement mode. Ensure you trust the agent and have appropriate version control in place.

### Agent Options

`settings.agentOptions` is an optional object for specifying per-agent model or effort preferences. Whether that intent can be applied depends on each adapter's capabilities:

```json
"agentOptions": {
  "codex": { "model": "gpt-5.4", "effort": "medium" },
  "claude": { "model": "opus" },
  "gemini": { "model": "gemini-2.5-flash" }
}
```

Rules:

- Both `model` and `effort` are optional. Omit to use the CLI's default.
- Keys must match a CLI adapter that appears either in the top-level `agents` list or in a CLI-backed role assignment. Provider-backed roles are configured under `providers`, not `agentOptions`.
- When an option cannot be applied, a warning is recorded on the step record and appears in the scratchpad output.

**Per-agent support:**

| Agent    | `model`                     | `effort`                                    |
|----------|-----------------------------|---------------------------------------------|
| codex    | Applied via `--model`. Any model string accepted. | Applied via `--reasoning-effort`. Allowed values: `low`, `medium`, `high`. |
| claude   | Applied via `--model`. Known values: `sonnet`, `opus`, `haiku`. **Unverified:** unrecognized model strings are passed through with a warning rather than blocked, since exact CLI tokens are pending verification. When an unverified model is used, effort validation is skipped entirely (no false claims about effort support based on the default model). | NOT automatable (requires interactive UI). Warning emitted if requested. |
| gemini   | Applied via `--model`. Allowed values: `gemini-3-flash-preview`, `gemini-3.1-flash-lite-preview`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`. Unrecognized values are rejected. | Not supported. Warning emitted if requested. |
| kilo     | Fixed to `Kilo Auto Free`. Requesting a different model produces a `fixed_model_only` warning. | Not supported. Warning emitted if requested. |
| qwen     | Fixed to `coder-model`. Requesting a different model produces a `fixed_model_only` warning. | Not supported. Warning emitted if requested. |
| opencode | Fixed to `MinMax M2.5 Free`. Requesting a different model produces a `fixed_model_only` warning. | Not supported. Warning emitted if requested. |

**Unknown keys are rejected.** Each `agentOptions.<agent>` object may only contain `model` and `effort` keys. Typos like `modle` or `efforts` will fail validation.

### Fallback Downgrades

When an agent's primary invocation fails and a fallback is used, some capabilities may be lost. The following fallbacks record `capabilityDowngrades` on the step record (visible in the scratchpad as `Fallback Downgrades: ...`):

| Agent | Fallback | Capabilities dropped |
|-------|----------|---------------------|
| claude | Minimal fallback | `--permission-mode` (write mode), `--model` |
| codex | Minimal fallback | `--sandbox` (write mode), `--model`, `--reasoning-effort` |
| qwen | Fallback | `--approval-mode` (write mode) |

The Codex safe fallback preserves write mode, model, and effort — no downgrade is recorded.

### One-Shot Origin Config

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
- The origin agent moves to the front of the agent list for that submode. All remaining agents keep their original relative order and participate as reviewers.
- If `oneShotOrigins` is partial or omitted, missing entries fall back to the first agent in `agents`.
- Write access in the implement sub-run follows the origin: only the implement origin agent receives `canWrite: true` (if its policy allows it).
- One-shot implement loops run per structured plan unit using `settings.implementLoopsPerUnit`.

See `shared/task.example.json` for a complete example.

## Using OpenAI-Compatible Providers and Context Folders

### Context folders

You can attach a context folder to a task with top-level `context.dir`:

```json
"context": {
  "dir": "./context",
  "maxFilesPerPhase": {
    "plan": 8,
    "implement": 12,
    "review": 10
  },
  "maxCharsPerPhase": {
    "plan": 20000,
    "implement": 30000,
    "review": 24000
  },
  "deliveryPolicy": {
    "planInitial": "full",
    "planReview": "digest",
    "reviewInitial": "full",
    "reviewParallel": "full",
    "reviewSynthesis": "digest",
    "implementInitial": "full",
    "implementReview": "full",
    "implementRepair": "digest"
  }
}
```

Folder conventions:

- `shared/`: reused in every phase when budget allows
- `plan/`: planning-specific material
- `implement/`: implementation-specific material
- `review/`: review-specific material
- `examples/`: reusable examples
- `schema/`: treated like implement-phase context
- `rubric/`: treated like review-phase context

`maxFilesPerPhase` limits how many files are selected for a phase. `maxCharsPerPhase` limits the total text budget before provider-specific limits are applied. `reviewPrompt` and `customImplementPrompt` still work normally and are the right place to steer what the agent should prioritize inside the selected context.

Context delivery is stage-aware. `context.deliveryPolicy` accepts `full`, `digest`, or `none` for these stage keys:

- `planInitial`
- `planReview`
- `reviewInitial`
- `reviewParallel`
- `reviewSynthesis`
- `implementInitial`
- `implementReview`
- `implementRepair`

Stage defaults:

| Stage key | Default |
| --- | --- |
| `planInitial` | `full` |
| `planReview` | `digest` |
| `reviewInitial` | `full` |
| `reviewParallel` | `full` |
| `reviewSynthesis` | `digest` |
| `implementInitial` | `full` |
| `implementReview` | `full` |
| `implementRepair` | `digest` |

Notes:

- `reviewSynthesis` governs plan-mode synthesis, review-mode synthesis, and one-shot review synthesis. There is no separate `planSynthesis` key.
- `deliveryPolicy.default` is a starting value, not a lock. Later-cycle automatic downgrade still applies to `planReview`, `reviewParallel`, and `implementReview` unless you set those stage keys directly.
- `reviewParallel` still defaults to `full`. If review-mode token usage is your main cost driver, `reviewParallel: "digest"` is the single biggest context-delivery override to try first. You can compare the prompt-char impact locally with `npm run measure:context` or `node scripts/measure-context-delivery.js`.
- The digest is built mechanically from the already selected files (path, selection reason, manifest purpose when present, truncation flag, and a shallow note such as the first heading), so it stays compact without depending on a second summarization pass.
- Provider `maxInputChars` limits the rendered digest section, not the entire final prompt. Other prompt sections still consume chars/tokens.
- In `context-selection` artifacts, `phase` is the selection bucket (`plan`, `review`, `implement`, or `one-shot`), while `stageKey` is the delivery-policy stage that requested that context (`reviewParallel`, `implementReview`, and so on).
- Runtime `[context]` log lines report actual emitted context chars for that step and note later-cycle automatic downgrades such as `(cycle 2 downgrade from full)`. Set `DIALECTIC_SILENT=1` to suppress them in CI or scripted runs.
- Set a stage to `none` to omit context entirely for that step.

Policy tuning workflow:

1. Measure a baseline with `npm run measure:context`.
2. If review-mode cost is the main issue, try `reviewParallel: "digest"` first.
3. For broader savings, try `deliveryPolicy.default: "digest"` and then restore specific stages such as `implementInitial` or `reviewInitial` to `full` where needed.
4. Use `none` only for stages that are safe without direct context.

If you want more control, set `context.manifest` to a JSON manifest file. Manifest entries can annotate files with `phase`, `priority`, or `purpose`, and those annotations are merged into the context index during selection.

### HTTP providers

You can configure local or remote OpenAI-compatible endpoints under top-level `providers`:

```json
"providers": {
  "nim-local": {
    "type": "openai-compatible",
    "baseUrl": "http://localhost:8000/v1",
    "apiKey": "dummy",
    "model": "Qwen/Qwen2.5-7B-Instruct",
    "maxInputChars": 16000,
    "chatTemplateMode": "openai",
    "retryPolicy": {
      "maxAttempts": 2,
      "backoffMs": 750
    }
  }
}
```

Notes:

- `model` is the served API model name, not necessarily the underlying checkpoint path on disk.
- HTTP providers are read-only in v1. They can plan and review, but they cannot be the implement origin.
- Readiness checks run before the mode starts. If a provider fails readiness, the run stops early with a clear error.
- `maxInputChars` feeds into full-context selection. If a provider has a smaller input budget than the phase default, the smaller budget wins for full context; digest delivery uses the phase budget so digest-configured stages can still carry a compact reference pack.
- `local` is an optional boolean. Set `"local": true` when a self-hosted provider should use the local run lock even if its URL is not a loopback hostname.
- `chatTemplateMode` controls payload and endpoint shape: `openai` sends `{messages:[{role:"user",content:...}]}` to `/chat/completions`, while `raw` sends `{prompt:"..."}` to `/completions` and expects an OpenAI completions-style `choices[0].text` response.
- `requestDefaults.timeoutMs` controls the transport timeout. Other `requestDefaults` keys are forwarded into the provider request payload unchanged after any built-in validation for known numeric fields.
- `retryPolicy` controls bounded retries for transient HTTP failures such as 429, 5xx, timeout, and connection errors.

### Planning questions

`planQuestionMode` controls what happens when the planner asks bounded strategic clarification questions after the first plan draft:

- `"autonomous"`: use the planner's defaults automatically
- `"interactive"`: pause once, before review, and ask you to answer the questions

Blank answers accept the planner default. Planner questions are intended to be strategic and bounded; a plan may also omit them entirely.

### Role mapping

You can assign providers or adapters to collaboration phases with top-level `roles`:

```json
"roles": {
  "planner": "nim-local",
  "reviewer": "claude",
  "fallback": "claude"
}
```

This lets you keep a simple `agents` list while explicitly steering who plans, who reviews, and who implements. Example: put planning on a local model and review on Claude without reordering the whole agent array manually.

`roles.fallback` is an optional runtime backup target. When a stage step returns any non-`ok` result, Dialectic retries that same step once with the fallback target (if different from the primary stage agent).

Important behavior:

- `roles` does not rewrite the top-level `agents` list.
- Dialectic still treats role targets as valid execution targets for preflight resolution and CLI-backed `agentPolicies` / `agentOptions`.
- Run logs and scratchpad metadata continue to show the declared `agents` list, preserving the order you wrote.
- `roles.fallback` currently triggers on any non-`ok` step result, not just retryable transport failures. That includes HTTP auth failures, bad requests, rate limits, timeouts, connection failures, server errors, and CLI-backed step failures.
- Because the fallback policy is broad, pointing `roles.fallback` at a paid remote model can lead to unexpected backup invocations if your primary provider is flaky.
- The easiest way to change your backup path is to edit only `roles.fallback`. It can point at any configured provider or CLI agent, so you can swap between a free/local backup and a paid remote backup without changing `agents` order or `settings.oneShotOrigins`.

One practical one-shot pattern is:

```json
"roles": {
  "fallback": "claude"
},
"settings": {
  "oneShotOrigins": {
    "plan": "gemini",
    "implement": "codex",
    "review": "claude"
  }
}
```

That keeps Codex as the write-capable implement origin while leaving a single fallback knob you can change later to another agent or provider.

### Local provider serialization

When a configured OpenAI-compatible provider points at `localhost`, `127.0.0.1`, or `::1`, Dialectic places a run lock under `shared/.locks/`. This prevents two runs from hammering the same local model server at once.

If your self-hosted endpoint is reachable through a LAN IP, Docker hostname, or another non-loopback address, set `"local": true` on that provider to opt into the same lock behavior.

- Lock files live at `shared/.locks/<providerId>.lock.json`
- Stale locks are cleaned up automatically when the recorded PID is no longer running
- If you need to clear one manually after a crash, delete the matching lock file

### Trust and safety

Transport compatibility does not imply model trust. If you point Dialectic at a local or self-hosted endpoint, you are responsible for validating the model source, prompt handling, and any surrounding infrastructure.

### Structured handoff note

Smaller local models may not reliably emit the structured handoff JSON block. Parse failures are logged and automatically fall back to prose, but collaboration quality may drop. Prefer stronger models for planning and review roles when structured handoff quality matters.

## CLI Usage

```bash
npm start
```

This runs the current `shared/task.json` directly. That manual JSON flow still works, but there is now a beginner-friendly CLI wrapper for common tasks.

### Beginner CLI

Use the wrapper CLI when you do not want to edit JSON by hand:

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

Preset commands:

```bash
npm run cli -- preset list
npm run cli -- preset save my-plan
npm run cli -- preset use my-plan
```

- Presets are stored under `shared/presets/`.
- `preset save <name>` copies the current validated `shared/task.json` into a named preset.
- `preset use <name>` copies that preset back into `shared/task.json` so you can rerun it with `npm run cli -- run`.

Recommended starter workflow:

1. Run `npm run cli -- plan` or `npm run cli:plan`.
2. Choose whether to run immediately or leave the generated `shared/task.json` for later.
3. Review the result in `shared/scratchpad.txt` after the task runs.
4. Save a setup you like with `npm run cli -- preset save my-plan`.
5. Re-run the current task later with `npm run cli -- run`.

## Files

- `src/orchestrator.js`: main orchestration loop
- `src/cli.js`: beginner-friendly CLI entrypoint
- `src/cli-commands.js`: CLI command routing and shared command handlers
- `src/cli-prompts.js`: reusable prompt helpers for the CLI wizards
- `src/cli-doctor.js`: shallow health check for the current task and CLI agents
- `src/cli-presets.js`: save/list/use helpers for named task presets
- `src/cli-wizard.js`: beginner wizard that writes validated task configs
- `src/adapters/index.js`: safe process execution and CLI resolution
- `src/handoff.js`: structured handoff extraction, fallback, and review-history compaction
- `src/prompts.js`: plan, review, and synthesis prompts
- `src/task-config.js`: config normalization and validation
- `shared/task.json`: current task configuration (edit before running)
- `shared/task.example.json`: example task config with all options
- `shared/presets/`: saved reusable task configurations for the CLI wrapper
- `shared/scratchpad.txt`: generated at runtime — human-readable run transcript
- `shared/log.json`: generated at runtime — append-only structured run log
- `shared/tasks/`: generated at runtime — per-run detailed records and artifacts

## Design Goals

- Keep prompt handoffs explicit and inspectable.
- Avoid shell injection by bypassing `cmd /c` wrappers.
- Treat non-zero exits and timeouts as real failures.
- Make the workflow configurable without editing source for normal runs.
