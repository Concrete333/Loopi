# Loopi

Loopi makes AI agents challenge each other on purpose.

Instead of trusting one model to plan, implement, review, and reinforce its own blind spots, Loopi turns multiple models into a structured workflow: one can plan, another can do the legwork, another can critique, and the system can loop until the result is good enough.

That means:

- smarter models can handle judgment-heavy steps
- cheaper or free models can handle execution-heavy work
- different models can catch each other's weak spots
- the workflow can keep refining instead of stopping after one pass

The result is not just "more AI." It is better output from controlled disagreement, explicit refinement loops, and grounded reference material.

Loopi is a workflow engine for getting the strongest result you can out of the models you already use.

One fast example:

- plan with Claude
- implement with Codex or OpenCode
- review with Gemini
- rerun the same workflow with different loop counts, fallback rules, or reference context

That is the core idea. Loopi turns "use multiple models" from a vague habit into a workflow you can actually inspect, reuse, and improve.

## Why Get Excited About Loopi

### 1. Make models pressure-test each other

A single coding agent has one training history, one alignment profile, one set of defaults, and one set of blind spots. When it reviews its own output, it often agrees with itself.

Loopi is built around structured disagreement.

A plan written by one model can be challenged by another. An implementation produced by one agent can be reviewed by a different one. A synthesis step then reconciles the conflict into a final decision instead of letting one model dominate the whole workflow.

This is the point: different models fail differently.

With Loopi, you can:

- plan with one model, implement with another, and review with a third
- run parallel reviews so you can see where models agree and where they conflict
- force stage-to-stage handoffs through structured artifacts instead of loose chat memory
- keep reviewers read-only while the chosen implementer is allowed to write

Loopi is not multi-agent for novelty. It is multi-agent so different models can expose each other's blind spots before those blind spots become your problem.

### 2. Decide how far the workflow goes

Most AI tools give you one pass and hide the rest.

Loopi makes refinement explicit.

You can run a couple of synthesis loops for a fast, already-powerful result. Or you can push a task through deeper planning, implementation, review, and repair cycles when you want the strongest output the system can produce.

That means Loopi can be:

- a quick two-loop quality pass
- a heavier multi-stage review cycle
- a long unattended workflow that keeps improving the output while you are away

You control how much quality pressure a task gets, and how much compute and token spend it deserves.

Loopi exposes three independent loop controls:

| Setting | Used by | What it controls |
| --- | --- | --- |
| `planLoops` | `plan`, `one-shot` | plan-review-synthesis cycles (for plan mode) or plan cycles per quality loop (for one-shot) |
| `qualityLoops` | `one-shot` | total outer one-shot reruns of the entire sequence |
| `sectionImplementLoops` | `one-shot` | per-section implement-review-repair cycles |
| `implementLoops` | `implement` | standalone implement -> review -> repair cycles |

Those controls let you do things like:

- loop the plan multiple times before implementation starts
- keep implementation cheap but review-heavy
- run more repair cycles only when a task is broken into units
- increase quality pressure without paying for your most expensive model at every stage

A powerful default pattern looks like this:

- use your smartest model to plan
- use a cheaper or free coding agent to implement
- use another model to review and challenge the result
- repeat the loop until the output is good enough

That is the leverage Loopi gives you.

### 3. Bring your own evidence

Most AI tools work from whatever is already in the repo, whatever fits in the prompt, or whatever happens to be in the current chat.

Loopi lets you attach an explicit `context` folder to a task so the workflow has real reference material to reason against during planning, implementation, and review.

That context can include things like:

- design docs
- research notes
- example code
- schemas
- specifications
- contracts or policy documents
- review rubrics
- supporting project files

This matters because better workflows need better evidence.

Instead of hoping one model remembers the right details, you can point Loopi at the exact body of material that should shape the work. That gives you control over not just which models run and how many times they loop, but what source material they reason against.

## What A Typical Run Looks Like

One practical Loopi workflow looks like this:

1. Attach a `context` folder with the docs, examples, schemas, specs, or other reference material that matters
2. Plan with Claude
3. Implement with Codex or OpenCode
4. Review with Gemini or another model
5. Repeat the implement -> review -> repair cycle until the result is strong enough
6. Save the scratchpad and structured per-run artifacts
7. Re-run later with different models, loop counts, fallback rules, provider assignments, or context rules

Loopi is not trying to replace the individual agent tools. It is the workflow layer above them.

## What You Can Use Loopi For

### Code creation from a prompt

Start with a bare idea, let one model plan the architecture, another write the implementation, and another review the result until the output is strong enough to keep.

### Existing codebase work

Point Loopi at a live repo plus supporting docs in the `context` folder, then use the workflow for feature work, refactors, bug hunts, and full reviews against the actual codebase.

### Team workflows with visible decision-making

Loopi keeps planning, review, and repair steps explicit. Instead of hidden internal reasoning, teams get a record of what was proposed, challenged, changed, and accepted.

### Other high-context knowledge work

The same workflow pattern can be applied beyond code: legal drafts using case law and example contracts, business plans grounded in research material, or academic writing built around source documents and structured review.

## What Loopi Actually Gives You

- explicit plan, implement, review, and repair stages instead of one long prompt thread
- multi-agent and multi-provider workflows with controlled write access
- structured artifacts and handoffs you can inspect instead of relying on chat history alone
- cost-aware model assignment across stages
- independent loop counts for outer quality cycles, implement/repair cycles, and per-unit one-shot cycles
- controlled reference context through a task-level `context` folder
- context and fallback controls you can tune for cost, reliability, and review quality

In practice, that means better output from the models you already use, with more visibility and less guesswork.

## Who It Is For

- developers who want more out of AI than one model in one chat can give them
- teams that want repeatable workflows with visible decision steps and recorded outputs
- people doing high-context work where planning, evidence, critique, and refinement all matter

## Requirements

- Windows is the primary platform today. The CLI and test workflow are exercised most heavily in Windows PowerShell.
- Node.js 20 or newer
- At least one supported AI coding CLI installed and authenticated
- A local Git repository for the project you want the agents to work on

## Install

```powershell
git clone https://github.com/Concrete333/Loopi.git my-project-folder
cd my-project-folder
npm install
```

You only need to install the agent CLIs you actually want to use.

One agent is enough to get started. Two or three is where Loopi starts to show what it can really do.

## Supported Agents

Loopi works with multiple coding-agent CLIs, and it can also route stages to OpenAI-compatible HTTP providers.

| Agent | Install / docs | Auth / setup | Loopi override |
| --- | --- | --- | --- |
| Claude Code | [Anthropic setup docs](https://docs.anthropic.com/en/docs/claude-code/getting-started) | Run `claude`, then follow the Anthropic / Claude login flow | `LOOPI_CLAUDE_PATH` |
| Codex CLI | [OpenAI Codex CLI getting started](https://help.openai.com/en/articles/11096431-openai-codex-ci-getting-started) | Run `codex auth login` or sign in when prompted | `LOOPI_CODEX_JS` |
| Gemini CLI | [Gemini CLI quickstart](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/index.md) | Run `gemini`, then choose your Google auth flow | `LOOPI_GEMINI_JS` |
| Kilo Code CLI | [Kilo Code CLI](https://kilocode.ai/cli) | Run `kilo auth login` and configure the provider you want to use | `LOOPI_KILO_PATH` |
| Qwen Code | [Qwen Code docs](https://qwenlm.github.io/qwen-code-docs/en/users/overview/) | Run `qwen`, then complete the Qwen OAuth / account setup | `LOOPI_QWEN_JS` |
| OpenCode | [OpenCode docs](https://opencode.ai/docs/) | Run `opencode`, then use `/connect` or `opencode auth login` to configure a provider | `LOOPI_OPENCODE_PATH` |

Any OpenAI-compatible HTTP endpoint can also be registered as a provider, whether that is a local inference server, an internal deployment, or a hosted service.

HTTP providers are always **read-only** in Loopi today. They can plan, review, and synthesize, but they cannot be the implementer.

## Quick Start

After you install at least one agent CLI, validate your setup. This works even before `shared/task.json` exists:

```powershell
npm run cli -- doctor
```

Then generate your first task interactively:

```powershell
npm run cli -- plan
```

If you prefer a browser-based setup flow, launch the local UI:

```powershell
npm run ui
```

That starts a localhost control plane for setup checks, task configuration, presets, and run monitoring. The UI now treats broken saved task files as first-class errors instead of hiding them, the Runs tab shows live background sessions while a run is still in flight, and the Setup tab can launch explicit install/login helpers for supported adapters. See [docs/ui.md](docs/ui.md) for the screen-by-screen guide.

Typical flow:

```text
What do you want the agents to do: Plan a small calculator app
Supported agents: 1) claude, 2) codex, 3) gemini, 4) kilo, 5) qwen, 6) opencode
Enter agent names or numbers separated by commas.
Which agents should help: 1,3
Run now? [Y/n]: y
Task written. Starting run...
```

If you answer `n` to `Run now?`, Loopi writes `shared/task.json` and prints the command to run it later.

A good first run is not "use every model." It is:

- one strong planner
- one implementer
- one different reviewer

That is usually enough to feel why the workflow matters.

## Modes

| Mode | Flow | Primary loop settings |
| --- | --- | --- |
| `plan` | initial plan -> review(s) -> synthesis | `planLoops` |
| `implement` | implement -> review(s) -> repair | `implementLoops` |
| `review` | initial review -> parallel reviews -> synthesis | (single pass by design) |
| `one-shot` | plan -> per-unit implement/review -> replan | `qualityLoops`, `planLoops`, `sectionImplementLoops` |

For example, one-shot with `qualityLoops = 2`, `planLoops = 2`, `sectionImplementLoops = 1` becomes:

```text
[plan x 2] -> [implement each section x 1] -> [plan x 2] -> [implement each section x 1]
```

With 3 planned sections, that is 4 total plan cycles and 6 total section implementations.

The important point is not just that Loopi has different modes. It is that each mode exposes a different kind of refinement loop, and you decide how much quality pressure and token spend a task deserves.

You can also assign different agents to different seats in the workflow. In `one-shot`, for example, `settings.oneShotOrigins` lets one agent own planning, another own implementation, and another own review. A separate `roles.fallback` target can be used if a primary provider fails.

## The Loopi Pattern

One of the simplest useful Loopi patterns is also one of the strongest:

- use your smartest and most expensive model to plan
- use a cheaper or free coding agent to implement
- use another model to review and challenge the result
- repeat the review/repair cycle until the work is good enough to keep

That is the leverage Loopi gives you.

You do not need to pay top-tier rates for every token in the workflow. You can place expensive intelligence where judgment matters most, cheaper execution where it is sufficient, and structured critique where quality needs pressure.

This is what makes Loopi feel different in practice: it lets you treat model quality, workflow structure, and token spend as things you can actually control.

## Why Explicit Loops Matter

Loopi exposes separate loop controls because different tasks need different kinds of pressure.

| Setting | Used by | What it controls |
| --- | --- | --- |
| `planLoops` | `plan`, `one-shot` | plan-review-synthesis cycles (for plan mode) or plan cycles per quality loop (for one-shot) |
| `qualityLoops` | `one-shot` | total outer one-shot reruns of the entire sequence |
| `sectionImplementLoops` | `one-shot` | per-section implement-review-repair cycles |
| `implementLoops` | `implement` | standalone implement -> review -> repair cycles |

### One-Shot Loop Nesting

In `one-shot` mode, the loop controls nest as follows:

1. For each outer `qualityLoops` cycle, run the plan stage `planLoops` times.
2. After the final plan result for that outer cycle is ready, implement each planned section.
3. For each section, run the implement-review-repair loop `sectionImplementLoops` times.
4. If there is another outer `qualityLoops` cycle remaining, rerun the full sequence again using the one-shot replan flow.

**Worked example:**

```json
{
  "mode": "one-shot",
  "useCase": "academic-paper",
  "prompt": "Write a research paper on AI safety",
  "agents": ["claude", "codex", "gemini"],
  "settings": {
    "planLoops": 4,
    "qualityLoops": 2,
    "sectionImplementLoops": 2
  }
}
```

If the plan has 3 sections, this configuration means:
- `8` total plan cycles (4 plan loops × 2 quality loops)
- `12` total section implementation cycles (3 sections × 2 section loops × 2 quality loops)

That means you can do things like:

- loop the plan multiple times before implementation starts
- keep implementation cheap but review-heavy
- run more repair cycles only when a task is broken into units
- increase quality pressure without paying for your most expensive model at every stage
- let a workflow keep improving while you are away instead of stopping after one pass

These loops are explicit and inspectable. Every pass writes artifacts, records which agent ran which stage, and leaves behind a workflow you can review, compare, and rerun later.

## Audit Trail And Run History

Loopi now records more than just the final answer.

Each run leaves behind a lightweight audit trail so a human can go back later and answer:

- which agent ran which stage
- when each step happened
- which write-enabled steps changed the worktree
- what patch snapshot was captured at run start, before and after write-enabled steps, and at run end
- whether a later attempt was manually forked from an earlier run

The main files and folders to look at are:

- `shared/scratchpad.txt`
- `shared/runs.ndjson`
- `shared/tasks/<runId>/task.json`
- `shared/tasks/<runId>/steps.ndjson`
- `shared/tasks/<runId>/artifacts/*.json`
- `shared/tasks/<runId>/patches/*.patch`

In practice:

- `scratchpad.txt` is the fastest human-readable summary
- `steps.ndjson` tells you which agent ran which stage and when
- `worktree-snapshot` artifacts capture run-start, pre-step, post-step, and run-end states; patch files are persisted for run-start/post-step/run-end, while pre-step is metadata-only by default
- `fork-record` artifacts record manual lineage when one run is explicitly based on an earlier run or step

This is meant to give you a durable record, not a fully automated replay system.

## Manual Fork Lineage

If you want to retry a prior attempt manually, you can include an optional top-level `fork` block in `shared/task.json` before you run it:

```json
{
  "mode": "implement",
  "prompt": "Retry the prior attempt with tighter scope.",
  "agents": ["codex", "gemini"],
  "fork": {
    "forkedFromRunId": "run-2026-04-21T12-34-56-789Z",
    "forkedFromStepId": "implement-4",
    "baseCommit": "abc123def456",
    "reason": "Retry with different reviewer feedback",
    "recordedBy": "manual"
  }
}
```

When present, Loopi writes a `fork-record` artifact and includes the lineage in the scratchpad and run log.

See `shared/task.example.json` for a fuller `manualForkExample`.

## Open Source and Support

Loopi is open source under the Apache License 2.0.

You are free to use, modify, and build on the project under the terms of that license.

If Loopi is useful to you or your team, there are a few ways to support the work:

- star and share the project on GitHub
- open issues and suggestions
- email cb1384@exeter.ac.uk for consulting, workflow design, implementation help, or custom integration support

If your team likes the workflow but wants help applying it in practice, the consulting path is there to accelerate adoption rather than gate the software.

See [LICENSE](./LICENSE) for the full license text and [LICENSING.md](./LICENSING.md) for a plain-language FAQ.

## Troubleshooting

- Run `npm run cli -- doctor` first. Without a task file it performs an environment/setup check; with `shared/task.json` present it also validates the task configuration and selected agents.
- If an agent is installed but not detected, set the matching `LOOPI_*` override.
- To find an installed CLI path on Windows, use `where.exe claude`, `where.exe codex`, `where.exe gemini`, and so on.
- On macOS or Linux, use `which claude`, `which codex`, `which gemini`, and so on.
- Advanced or developer override: set `LOOPI_PROJECT_ROOT` to point the CLI at a different project root.

## Deeper Documentation

The README is the front door.

For deeper configuration and runtime details, see:

- [docs/cli.md](./docs/cli.md)
- [docs/config.md](./docs/config.md)
- [docs/context.md](./docs/context.md)
- [docs/providers.md](./docs/providers.md)

## Why Not Just Use Cursor, Codex, Or Copilot Alone?

Those tools are excellent at single-agent execution. Loopi is for workflows where one model, one pass, and one internal line of reasoning are not enough.

Use Loopi when you want to:

- Route plan, implement, and review to agents trained by different organizations on different data, so a single model's failure mode does not become the workflow's failure mode
- Run implement -> review -> repair for as many cycles as the task needs, with a different reviewer each pass
- Give the workflow an explicit body of reference material through the `context` folder instead of relying only on repo state or chat history
- Mix CLI agents and OpenAI-compatible providers in the same workflow
- Control which step can write and which steps stay read-only
- Keep workflow state in structured artifacts instead of ephemeral chat context
- Tune context delivery, fallback behavior, and loop counts per task instead of accepting one default runtime model

Loopi is not trying to replace the agent tools themselves.

It is the layer that makes them work together harder, more visibly, and more usefully than they do alone.
