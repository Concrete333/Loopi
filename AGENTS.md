# Loopi - Public Agent Guide

This file helps AI agents understand the public Loopi codebase quickly.

## What this project is

Loopi is a Node.js orchestration runtime for structured AI coding workflows.

It coordinates multiple coding-agent CLIs and OpenAI-compatible HTTP providers through explicit modes such as:

- `plan`
- `implement`
- `review`
- `one-shot`

The main user-facing workflow is wrapper-CLI-first, with a local browser UI available for setup, task editing, context preparation, and run monitoring.

## How users normally use it

The normal path is:

1. Run `npm run cli -- doctor`
2. Run `npm run cli -- plan` / `review` / `implement` / `oneshot`
3. Follow the interactive prompts
4. If the task uses `context`, run `npm run cli -- context prepare` before the first run and again after context files or context rules change
5. Run the task and review results in `shared/scratchpad.txt`

When `shared/task.json` exists and includes `context`, `doctor` also checks prepared-context readiness so users can catch invalid paths, missing caches, or drift before launching a run.

The browser UI is also a first-class path:

1. Run `npm run ui`
2. Use Setup and Settings to configure agents/providers and edit the task
3. Prepare context in Settings when `context` is configured
4. Launch and monitor the run from the UI; `Run Now` validates the current draft before persisting it, so blocked launches do not overwrite the saved task file

`shared/task.json` exists as the current task file used by the CLI and runtime, but it is a secondary/manual path rather than the primary interface.

## Mental model

Loopi is best understood as a workflow layer above individual coding agents.

It adds:

- explicit multi-step orchestration
- structured handoffs between stages
- provider routing
- controlled write access
- traceable run artifacts
- context selection and delivery controls
- explicit prepared-context reuse through `.loopi-context/`
- safe UI launch gating for draft validation and prepared-context blockers
- live run-session monitoring through the local control plane

Execution-boundary notes:

- `settings.agentPolicies.*.canWrite` is the source of truth for write-enabled implement steps.
- Adapter-specific agent mode options must not override the current step's read/write policy.
- `roles.fallback` inherits the failed step's temporary read/write policy, but HTTP providers are read-only and cannot replace failed write-enabled steps.
- HTTP provider readiness requires an exact case-insensitive model ID match from `/v1/models`.
- One-shot implementation summaries aggregate all completed units.

## Key files

| File | Role |
|---|---|
| `src/orchestrator.js` | Main orchestration loop |
| `src/cli.js` | Main CLI entrypoint |
| `src/cli-commands.js` | CLI command routing |
| `src/cli-wizard.js` | Interactive wizard flow |
| `src/cli-presets.js` | Saved preset helpers |
| `src/cli-doctor.js` | Setup and task health checks |
| `src/context-index.js` | Context preparation, prepared-cache consumption, and readiness checks |
| `src/control-plane/index.js` | Local app service logic, including context status/prepare and run launch gating |
| `src/control-plane/server.js` | HTTP server for the local browser UI |
| `src/adapters/index.js` | CLI agent and HTTP provider execution |
| `src/task-config.js` | Config normalization and validation |
| `src/prompts.js` | Prompt construction for workflow stages |
| `src/handoff.js` | Structured handoff parsing and validation |
| `src/collaboration-store.js` | Persistent run/task/step/artifact storage |

## Important runtime artifacts

Loopi writes runtime state to:

- `shared/scratchpad.txt`
- `shared/log.json`
- `shared/runs.ndjson`
- `shared/tasks/<runId>/task.json`
- `shared/tasks/<runId>/steps.ndjson`
- `shared/tasks/<runId>/artifacts/*.json`
- `shared/tasks/<runId>/patches/*.patch`

These files matter when understanding what happened in a run.

If a task uses `context`, there is also a generated cache under the configured context root:

- `.loopi-context/manifest.json`
- `.loopi-context/normalized/*`

Important audit-trail note:

- `worktree-snapshot` artifacts describe run-start, pre-step, post-write-step, and run-end worktree state
- `patches/*.patch` contains the captured diff text referenced by those artifacts
- `fork-record` artifacts capture manual lineage when a task is explicitly forked from an earlier run or step
- `shared/scratchpad.txt` is the quickest human-readable way to discover those files

## Execution modes

| Mode | Flow |
|---|---|
| `plan` | initial plan -> review(s) -> synthesis |
| `implement` | implement -> review(s) -> repair |
| `review` | initial review -> parallel reviews -> synthesis |
| `one-shot` | plan -> per-unit implement/review -> replan |

## Handoff protocol

Stages may pass structured state using:

```text
BEGIN_HANDOFF_JSON
{ ... }
END_HANDOFF_JSON
```

If this block is missing or malformed, the system can fall back to prose handoff.

## Quick orientation path for AI agents

If you need to understand the project quickly, start here:

1. `README.md`
2. `src/cli.js`
3. `src/cli-commands.js`
4. `src/task-config.js`
5. `src/context-index.js`
6. `src/control-plane/index.js`
7. `src/orchestrator.js`
8. `src/adapters/index.js`
9. `src/handoff.js`

## What this file is not

This is not the internal development guide for building, packaging, or publishing Loopi.

It is only a concise public-facing orientation file to help AI agents and contributors navigate the codebase and understand the shipped product shape.
