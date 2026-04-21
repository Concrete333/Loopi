# Providers and Routing

## HTTP Providers

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
- `maxInputChars` feeds into full-context selection.
- `local` is an optional boolean. Set `"local": true` when a self-hosted provider should use the local run lock even if its URL is not a loopback hostname.
- `chatTemplateMode` controls payload and endpoint shape.
- `requestDefaults.timeoutMs` controls the transport timeout.
- `retryPolicy` controls bounded retries for transient HTTP failures such as 429, 5xx, timeout, and connection errors.

## Planning Questions

`planQuestionMode` controls what happens when the planner asks bounded strategic clarification questions after the first plan draft:

- `"autonomous"`: use the planner's defaults automatically
- `"interactive"`: pause once, before review, and ask you to answer the questions

Blank answers accept the planner default.

## Role Mapping

You can assign providers or adapters to collaboration phases with top-level `roles`:

```json
"roles": {
  "planner": "nim-local",
  "reviewer": "claude",
  "fallback": "claude"
}
```

This lets you keep a simple `agents` list while explicitly steering who plans, who reviews, and who implements.

Important behavior:

- `roles` does not rewrite the top-level `agents` list.
- Dialectic still treats role targets as valid execution targets for preflight resolution and CLI-backed `agentPolicies` and `agentOptions`.
- Run logs and scratchpad metadata continue to show the declared `agents` list.
- `roles.fallback` currently triggers on any non-`ok` step result, not just retryable transport failures.
- Pointing `roles.fallback` at a paid remote model can lead to unexpected backup invocations if your primary provider is flaky.

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

That keeps Codex as the write-capable implement origin while leaving a single fallback knob you can change later.

## Local Provider Serialization

When a configured OpenAI-compatible provider points at `localhost`, `127.0.0.1`, or `::1`, Dialectic places a run lock under `shared/.locks/`.

- Lock files live at `shared/.locks/<providerId>.lock.json`
- Stale locks are cleaned up automatically when the recorded PID is no longer running
- If you need to clear one manually after a crash, delete the matching lock file

If your self-hosted endpoint is reachable through a LAN IP, Docker hostname, or another non-loopback address, set `"local": true` on that provider to opt into the same lock behavior.

## Trust and Safety

Transport compatibility does not imply model trust. If you point Dialectic at a local or self-hosted endpoint, you are responsible for validating the model source, prompt handling, and any surrounding infrastructure.

## Structured Handoff Note

Smaller local models may not reliably emit the structured handoff JSON block. Parse failures are logged and automatically fall back to prose, but collaboration quality may drop. Prefer stronger models for planning and review roles when structured handoff quality matters.
