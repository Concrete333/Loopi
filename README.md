# Dialectic

Dialectic is a source-available orchestration runtime for structured AI coding workflows.

It helps teams run plan, implement, review, and one-shot loops across multiple coding-agent CLIs and OpenAI-compatible providers with explicit handoffs, controlled write access, and traceable artifacts.

## What It Looks Like

One common Dialectic workflow is:

1. Plan with Claude
2. Implement with Codex
3. Review with Gemini
4. Save the human-readable scratchpad plus structured per-run artifacts
5. Re-run later with different fallback, provider, or context rules

Dialectic is not trying to replace the individual agent tools. It is the workflow layer above them.

## Why It Exists

When teams move beyond one agent and one chat thread, the hard problems are no longer just prompting. They are workflow structure, review discipline, context control, fallback behavior, and traceability.

Dialectic gives you:

- Explicit plan, implement, review, and repair stages instead of one long prompt thread
- Multi-agent and multi-provider workflows with controlled write access
- Structured artifacts and handoffs you can inspect instead of relying on chat history alone
- Context delivery and fallback controls you can tune for cost, reliability, and review quality

## Who It Is For

- Developers who already use more than one coding agent or model
- Agencies and platform teams that want repeatable coding workflows instead of prompt-by-prompt improvisation
- Local-first teams that need explicit control over write access, context delivery, and provider routing

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
Which agents should help: 1
Run now? [Y/n]: y
Task written. Starting run...
```

If you answer `n` to `Run now?`, Dialectic writes `shared/task.json` and prints the command to run it later.

## Modes

Dialectic currently supports:

- `plan`: initial plan -> review(s) -> synthesis
- `implement`: implement -> review(s) -> repair
- `review`: initial review -> parallel reviews -> synthesis
- `one-shot`: plan -> per-unit implement/review -> replan until the requested loop count is exhausted

For `qualityLoops = 3`, one-shot becomes:

`plan -> implement -> review -> plan -> implement -> review -> plan -> implement`

## Licensing

Dialectic is licensed under the Business Source License 1.1 (`BUSL-1.1`).

- Non-production use is permitted, including evaluation, development, testing, research, and personal or other non-commercial experimentation.
- Production use requires a separate commercial license.
- On `2029-04-21`, this version converts to the Apache License, Version 2.0.
- For commercial licensing, contact: https://github.com/Concrete333

See [LICENSE](./LICENSE) for the full license text and [LICENSING.md](./LICENSING.md) for plain-language examples of what counts as non-production and production use.

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

Those tools are excellent at single-agent execution. Dialectic is for teams that want a workflow around the model, not just access to the model.

- Mix CLI agents and OpenAI-compatible providers in the same workflow
- Control which step can write and which steps stay read-only
- Keep workflow state in structured artifacts instead of ephemeral chat context
- Tune context delivery and fallback behavior instead of accepting one default runtime model
