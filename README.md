# Dialectic

Dialectic makes AI coding agents challenge each other on purpose.

Instead of trusting one model to plan, implement, review, and reinforce its own blind spots, Dialectic lets you assign different agents to different stages, control how many times the workflow loops, and decide exactly what reference material the workflow reasons against.

The result is simple:

- better output from models that disagree usefully
- tighter control over cost, token spend, and refinement depth
- workflows you can inspect, replay, and tune instead of opaque chat sessions

Dialectic is a source-available orchestration runtime for teams that want AI coding workflows to behave like systems, not improvisations.

One fast example:

- plan with Claude
- implement with Codex or OpenCode
- review with Gemini
- rerun the same workflow later with different loop counts, fallback rules, or reference context

That is the core idea. Dialectic turns "use multiple models" from a vague habit into a workflow you can actually inspect, reuse, and improve.

## Why Teams Get Excited About Dialectic

### 1. Make models disagree on purpose

A single coding agent has one training history, one alignment profile, one set of defaults, and one set of blind spots. When it reviews its own output, it often agrees with itself.

Dialectic is built around structured disagreement.

A plan written by one agent can be reviewed by another. An implementation produced by one model can be challenged by a different reviewer. A synthesis step then reconciles the disagreements into a final decision instead of letting one model dominate the whole workflow.

This is the point: different models fail differently.

With Dialectic, you can:

- plan with one model, implement with another, and review with a third
- run parallel reviews so you can see where agents agree and where they conflict
- force stage-to-stage handoffs through structured artifacts instead of loose chat memory
- keep reviewers read-only while the chosen implementer is allowed to write

Dialectic is not multi-agent for novelty. It is multi-agent so different models can expose each other's blind spots before those blind spots become your problem.

### 2. Put expensive intelligence where it matters

Most AI tools force you into one runtime, one model path, and one hidden retry strategy.

Dialectic gives you control over the quality/cost frontier.

You choose:

- which model plans
- which model writes
- which model reviews
- which steps stay read-only
- how many times the workflow loops

That means you can use your smartest and most expensive model where judgment matters most, use cheaper or free models where execution is good enough, and still improve quality through structured review and repair cycles.

A powerful default pattern looks like this:

- use your smartest model to plan
- use a cheaper or free coding agent to implement
- use another model to review and challenge the result
- repeat the loop until the output is good enough

Instead of paying premium prices for every stage, you can concentrate spend where it creates the most leverage.

Dialectic exposes three independent loop controls:

| Setting | Used by | What it controls |
| --- | --- | --- |
| `qualityLoops` | `plan`, `one-shot` | outer quality cycles |
| `implementLoops` | `implement`, `one-shot` | implement -> review -> repair cycles |
| `implementLoopsPerUnit` | `one-shot` | per-unit implement/review/repair cycles |

These loops are explicit, inspectable, and tunable per task. Every pass writes artifacts, records which agent ran which stage, and makes the workflow's behavior visible.

### 3. Bring your own evidence

Most AI tools work from whatever is already in the repo, whatever fits in the prompt, or whatever happens to be in the current chat.

Dialectic lets you attach an explicit `context` folder to a task so the workflow has real reference material to reason against during planning, implementation, and review.

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

Instead of hoping one model remembers the right details, you can point Dialectic at the exact body of material that should shape the work. That gives you control over not just which agents run and how many times they loop, but what source material they reason against.

## What A Typical Run Looks Like

One practical Dialectic workflow looks like this:

1. Attach a `context` folder with the docs, examples, schemas, specs, or other reference material that matters
2. Plan with Claude
3. Implement with Codex or OpenCode
4. Review with Gemini or another model
5. Repeat the implement -> review -> repair cycle until the result is strong enough
6. Save the scratchpad and structured per-run artifacts
7. Re-run later with different agents, loop counts, fallback rules, provider assignments, or context rules

Dialectic is not trying to replace the individual agent tools. It is the workflow layer above them.

## What Dialectic Actually Gives You

- explicit plan, implement, review, and repair stages instead of one long prompt thread
- multi-agent and multi-provider workflows with controlled write access
- structured artifacts and handoffs you can inspect instead of relying on chat history alone
- cost-aware model assignment across stages
- independent loop counts for outer quality cycles, implement/repair cycles, and per-unit one-shot cycles
- controlled reference context through a task-level `context` folder
- context and fallback controls you can tune for cost, reliability, and review quality

In practice, that means better output from the models you already use, with more visibility and less guesswork.

## Who It Is For

- Developers who already use more than one coding agent or model
- Agencies and platform teams that want repeatable coding workflows instead of prompt-by-prompt improvisation
- Local-first teams that need explicit control over write access, context delivery, provider routing, and cost

## Requirements

- Windows is the primary platform today. The CLI and test workflow are exercised most heavily in Windows PowerShell.
- Node.js 20 or newer
- At least one supported AI coding CLI installed and authenticated
- A local Git repository for the project you want the agents to work on

## Install

```powershell
git clone <your-repo-url>
cd Dialectic
npm install
```

You only need to install the agent CLIs you actually want to use. Starting with one is fine, but Dialectic becomes more valuable as soon as you run different agents against each other.

## Supported Agents

Dialectic works with multiple coding-agent CLIs, and it can also route stages to OpenAI-compatible HTTP providers.

| Agent | Install / docs | Auth / setup | Dialectic override |
| --- | --- | --- | --- |
| Claude Code | [Anthropic setup docs](https://docs.anthropic.com/en/docs/claude-code/getting-started) | Run `claude`, then follow the Anthropic / Claude login flow | `DIALECTIC_CLAUDE_PATH` |
| Codex CLI | [OpenAI Codex CLI getting started](https://help.openai.com/en/articles/11096431-openai-codex-ci-getting-started) | Run `codex auth login` or sign in when prompted | `DIALECTIC_CODEX_JS` |
| Gemini CLI | [Gemini CLI quickstart](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/index.md) | Run `gemini`, then choose your Google auth flow | `DIALECTIC_GEMINI_JS` |
| Kilo Code CLI | [Kilo Code CLI](https://kilocode.ai/cli) | Run `kilo auth login` and configure the provider you want to use | `DIALECTIC_KILO_PATH` |
| Qwen Code | [Qwen Code docs](https://qwenlm.github.io/qwen-code-docs/en/users/overview/) | Run `qwen`, then complete the Qwen OAuth / account setup | `DIALECTIC_QWEN_JS` |
| OpenCode | [OpenCode docs](https://opencode.ai/docs/) | Run `opencode`, then use `/connect` or `opencode auth login` to configure a provider | `DIALECTIC_OPENCODE_PATH` |

Any OpenAI-compatible HTTP endpoint can also be registered as a provider, whether that is a local inference server, an internal deployment, or a hosted service.

HTTP providers are always **read-only** in Dialectic today. They can plan, review, and synthesize, but they cannot be the implementer.

## Quick Start

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
Which agents should help: 1,3
Run now? [Y/n]: y
Task written. Starting run...
```

If you answer `n` to `Run now?`, Dialectic writes `shared/task.json` and prints the command to run it later.

A good first run is not "use every model." It is:

- one strong planner
- one implementer
- one different reviewer

That is usually enough to feel why the workflow matters.

## Modes

| Mode | Flow | Primary loop setting |
| --- | --- | --- |
| `plan` | initial plan -> review(s) -> synthesis | `qualityLoops` |
| `implement` | implement -> review(s) -> repair | `implementLoops` |
| `review` | initial review -> parallel reviews -> synthesis | (single pass by design) |
| `one-shot` | plan -> per-unit implement/review -> replan | `qualityLoops` + `implementLoopsPerUnit` |

For example, one-shot with `qualityLoops = 3` becomes:

```text
plan -> implement -> review -> plan -> implement -> review -> plan -> implement
```

The important point is not just that Dialectic has different modes. It is that each mode exposes a different kind of refinement loop, and you decide how much quality pressure and token spend a task deserves.

You can also assign different agents to different seats in the workflow. In `one-shot`, for example, `settings.oneShotOrigins` lets one agent own planning, another own implementation, and another own review. A separate `roles.fallback` target can be used if a primary provider fails.

## The Dialectic Pattern

One of the simplest useful Dialectic patterns is also one of the most powerful:

- use your smartest and most expensive model to plan
- use a cheaper or free coding agent to implement
- use another model to review and challenge the result
- repeat the review/repair cycle until the task is good enough

That is the leverage Dialectic gives you.

You do not need to pay top-tier rates for every token in the workflow. You can place expensive intelligence where judgment matters most, cheaper execution where it is sufficient, and structured critique where quality needs pressure.

## Why Explicit Loops Matter

Dialectic exposes three separate loop controls because different tasks need different kinds of refinement:

| Setting | Used by | What it controls |
| --- | --- | --- |
| `qualityLoops` | `plan`, `one-shot` | outer quality cycles |
| `implementLoops` | `implement`, `one-shot` | implement -> review -> repair cycles |
| `implementLoopsPerUnit` | `one-shot` | per-unit implement/review/repair cycles |

That means you can do things like:

- loop the plan multiple times before implementation starts
- keep implementation cheap but review-heavy
- run more repair cycles only when a task is broken into units
- increase quality pressure without paying for your most expensive model at every stage

These loops are explicit and inspectable. Every pass writes artifacts, records which agent ran which stage, and leaves behind a workflow you can review and rerun later.

## Open Source and Support

Dialectic is open source under the Apache License 2.0.

You are free to use, modify, and build on the project under the terms of that license.

If Dialectic is useful to you or your team, there are a few ways to support the work:

- star and share the project on GitHub
- open issues and suggestions
- email `cb1384@exeter.ac.uk` for consulting, workflow design, implementation help, or custom integration support

If your team likes the workflow but wants help applying it in practice, the consulting path is there to accelerate adoption rather than gate the software.

See [LICENSE](./LICENSE) for the full license text and [LICENSING.md](./LICENSING.md) for a plain-language FAQ.

## Troubleshooting

- Run `npm run cli -- doctor` first. It validates the current task configuration and checks that the selected CLI agents appear usable.
- If an agent is installed but not detected, set the matching `DIALECTIC_*` override.
- To find an installed CLI path on Windows, use `where.exe claude`, `where.exe codex`, `where.exe gemini`, and so on.
- On macOS or Linux, use `which claude`, `which codex`, `which gemini`, and so on.
- Advanced or developer override: set `DIALECTIC_PROJECT_ROOT` to point the CLI at a different project root.

## Deeper Documentation

The README is intentionally the front door. For deeper configuration and runtime details, see:

- [docs/cli.md](./docs/cli.md)
- [docs/config.md](./docs/config.md)
- [docs/context.md](./docs/context.md)
- [docs/providers.md](./docs/providers.md)

## Why Not Just Use Cursor, Codex, Or Copilot Alone?

Those tools are excellent at single-agent execution. Dialectic is for workflows where a single agent's blind spots are not acceptable.

- Route plan, implement, and review to agents trained by different organizations on different data, so a single model's failure mode does not become the workflow's failure mode
- Run implement -> review -> repair for as many cycles as the task needs, with a different reviewer each pass
- Give the workflow an explicit body of reference material through the `context` folder instead of relying only on repo state or chat history
- Mix CLI agents and OpenAI-compatible providers in the same workflow
- Control which step can write and which steps stay read-only
- Keep workflow state in structured artifacts instead of ephemeral chat context
- Tune context delivery, fallback behavior, and loop counts per task instead of accepting one default runtime model
