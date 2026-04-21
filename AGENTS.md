# Dialectic - Agent Orientation

Read this file before making any changes to the codebase.

## What this project does

Dialectic is a Node.js orchestration layer that coordinates multiple AI coding agent CLIs and OpenAI-compatible HTTP providers in structured collaboration loops. It supports deliberate **plan -> implement -> review -> synthesize** workflows with structured handoffs between steps.

The goal is an easy-to-use application that lets multiple LLMs from different sources collaborate on real projects with clear orchestration, traceability, and guardrails.

## Hard rules - do not violate these

**Keep the core runtime dependency-free.**
The main orchestration layer and its `plan` / `implement` / `review` loops should remain free of general runtime npm dependencies. Prefer Node.js built-ins such as `fs`, `path`, `child_process`, `os`, `http`, and `https`.

**Scoped exception for context ingestion.**
Context-related ingestion/retrieval modules may use carefully chosen dependencies when they materially improve document support or retrieval quality. Be cautious about niche or low-value packages.

**Do not remove or break existing CLI adapters.**
`claude`, `codex`, `gemini`, `kilo`, `qwen`, and `opencode` must continue to work as they do today.

**Windows is the primary platform.**
Use `path.join` / `path.resolve`. Do not hardcode `/`. Use `taskkill /T /F` for process cleanup rather than assuming Unix signals.

**Validation happens at config load time.**
If a config value is invalid, throw early in `src/task-config.js` with a clear message. Do not let bad config drift into the execution layer.

## How to run tests

Preferred on Windows PowerShell:

```powershell
npm.cmd test
```

Tests live in `tests/` and use plain Node.js `assert`. They must not require live providers, real network access beyond local mocks, or external binaries outside the current project assumptions.

Single-file examples:

```powershell
node tests/task-config.test.js
node tests/orchestrator.test.js
```

## Key files

| File | Responsibility |
|---|---|
| `src/orchestrator.js` | Main `DialecticOrchestrator` class and runtime entrypoint |
| `src/cli.js` | Beginner-friendly CLI entrypoint |
| `src/cli-commands.js` | CLI command routing and shared command handlers |
| `src/cli-wizard.js` | Beginner and advanced wizard flows for writing validated task configs |
| `src/cli-presets.js` | Save/list/use helpers for named task presets |
| `src/cli-doctor.js` | Shallow health check for the current task and selected CLI agents |
| `src/adapters/index.js` | CLI + HTTP provider execution, retries, envelopes, readiness |
| `src/prompts.js` | Prompt construction for all modes/phases |
| `src/handoff.js` | Structured handoff extraction, validation, and rendering |
| `src/task-config.js` | Config normalization and validation |
| `src/context-index.js` | Context-folder scanning and indexing |
| `src/context-selection.js` | Phase-aware bounded context selection |
| `src/context-delivery.js` | Stage-key registry and default full/digest/none context policy |
| `src/retry-policy.js` | Shared retry-policy defaults and validation |
| `src/run-lock.js` | Local-provider run locking |
| `src/collaboration-store.js` | V2 run/task/step/artifact persistence |
| `src/task-paths.js` | Path resolution and safe path helpers |
| `src/use-case-loader.js` | Use-case config loading/validation |

## Handoff protocol

Agents are expected to append a structured block:

```text
BEGIN_HANDOFF_JSON
{ ... }
END_HANDOFF_JSON
```

Dialectic extracts and validates this via `src/handoff.js`.

If the block is missing or malformed, orchestration falls back to prose handoff. That is non-fatal, but collaboration quality drops.

When changing prompt builders, always preserve the handoff guidance.

## Execution modes

| Mode | Flow |
|---|---|
| `plan` | initial plan -> review(s) -> synthesis |
| `implement` | implement -> review(s) -> repair |
| `review` | initial review -> parallel reviews -> synthesis |
| `one-shot` | plan -> per-unit implement/review -> replan |

## Current checkpoint (reviewed 2026-04-20)

### What is implemented

- Phase A is complete.
- Phase B commits 1-20 are complete.
- HTTP providers are fully routed through `runHttpProvider()` and the canonical result envelope.
- The HTTP read-only rule is enforced: configured HTTP providers cannot be the implement origin.
- Context folders are fully wired into orchestration and prompts.
- Plan clarification checkpoints support both `interactive` and `autonomous` flows.
- Local-provider run locks are active, including explicit provider opt-in via `local: true`.
- Readiness, provider execution, context selection, and plan clarification artifacts are written through the collaboration store.
- The wrapper CLI is live:
  - beginner commands: `plan`, `review`, `implement`, `oneshot`, `run`, `open`
  - support commands: `preset list/save/use`, `doctor`, `new --advanced`
- `npm.cmd test` is green in the current Windows PowerShell environment.

### Important current behavior

- `runMode()` handles provider-assignment validation, readiness, local-provider locking, context initialization, artifact writing, and mode dispatch.
- The wrapper CLI writes normal `shared/task.json` configs, validates them through `normalizeTaskConfig`, and then hands off to the existing orchestrator instead of duplicating runtime logic.
- Context delivery is stage-aware:
  - stage keys are resolved through `src/context-delivery.js`
  - defaults are mixed: `planReview`, `reviewSynthesis`, and `implementRepair` are digest by default, while `reviewParallel` still defaults to full
  - later cycles may automatically downgrade `planReview`, `reviewParallel`, and `implementReview` from `full` to `digest` unless those stage keys were set explicitly
  - `deliveryPolicy.default` is a starting value, not a lock, for that cycle-aware downgrade logic
- Context selection now budgets against the actual emitted excerpt, not raw full-file length.
- `context-selection` artifacts now record `phase`, `stageKey`, `delivery`, and `suppressed`; `phase` is the selection bucket and `stageKey` is the delivery-policy stage that requested the context.
- Orchestrator context logs now report actual emitted context chars and annotate later-cycle `full -> digest` downgrades inline.
- The context indexer intentionally favors reference/document formats rather than source-code file types.
- Retry-policy defaults and validation are shared through `src/retry-policy.js`; normalized provider configs currently carry a fully populated retry policy.
- `npm run measure:context` is available as a deterministic local benchmark for review-mode context-delivery cost.
- The advanced CLI path is intentionally narrow: `new --advanced` adds optional `reviewPrompt`, `synthesisPrompt`, and `customImplementPrompt`, but still keeps the deeper config surface in manual JSON territory.

### Known follow-ups

- `src/orchestrator.js` is still the main maintenance hotspot and should be split by concern before major new features land.
- `tests/orchestrator.test.js` is now a thin entrypoint; focused coverage lives under `tests/orchestrator/` and should stay split by concern.
- Logging is improved but not fully centralized yet.
- Digest render caps apply to the digest section, not the whole prompt; keep that distinction in mind when changing prompt structure or provider budget handling.
- Re-verify less-traveled provider config such as `roles.fallback` and `chatTemplateMode` before building new behavior on top of them.

### Fast audit path for future agents

1. Read `src/task-config.js`.
2. Read `src/orchestrator.js`.
3. Read `src/adapters/index.js`.
4. Read `src/context-index.js`, `src/context-selection.js`, and `src/prompts.js`.
5. Use these tests as the highest-signal regression set:
   - `tests/task-config.test.js`
   - `tests/orchestrator.test.js`
   - `tests/orchestrator/*.js`
   - `tests/adapters.test.js`
   - `tests/context-index.test.js`
   - `tests/context-selection.test.js`
   - `tests/prompts.test.js`

## Run output structure

Each run writes to:

1. Legacy outputs:
   - `shared/scratchpad.txt`
   - `shared/log.json`
2. V2 store:
   - `shared/tasks/<runId>/task.json`
   - `shared/tasks/<runId>/steps.ndjson`
   - `shared/tasks/<runId>/artifacts/*.json`

Always use `collaboration-store.js` to write persistent run state.

## Config shape

Minimum valid config:

```json
{
  "task": "Your task description",
  "mode": "review",
  "agents": ["claude"]
}
```

See `shared/task.example.json` for the current annotated example.

If you add a new config field, update:

- `src/task-config.js`
- `tests/task-config.test.js`
- `shared/task.example.json`
- `README.md` when user-facing behavior changes

## When in doubt

- Read `src/task-config.js` to understand what config is valid.
- Read `src/cli-commands.js` and `src/cli-wizard.js` to understand the shipped wrapper CLI behavior.
- Read `src/orchestrator.js` to understand the runtime flow.
- Read `src/handoff.js` to understand how agents pass structured state.
- Run `npm.cmd test` after every meaningful change.
