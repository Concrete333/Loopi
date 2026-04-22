# Audit Trail Follow-Up Plan

## Goal

Address the current audit-trail review findings without losing the core value of the feature:

- keep a trustworthy human-readable record
- avoid misleading lineage
- reduce avoidable disk, token, and runtime overhead
- keep the CLI simple for normal users

This plan assumes the existing audit trail remains a record system, not an automated replay engine.

## Findings This Plan Addresses

1. `fork <runId> [stepId]` records a step id but does not actually fork from that step's recorded state.
2. Run-level audit references can claim artifacts exist even if persistence failed.
3. Pre-step and post-step snapshots currently capture more full diff data than necessary.
4. The `fork` CLI parser accepts unknown flags as positional input.
5. The scratchpad duplicates snapshot metadata in two places, increasing noise and token cost.

## Design Principles

### 1. Audit records must be honest

If a file or artifact was not successfully written, the user-facing record should not imply that it was.

### 2. Step-scoped actions must actually respect the step

If a user names `implement-2`, the resulting lineage should either point at `implement-2` or fail clearly.

### 3. Keep the heavy evidence where it matters

We only need full patch text where it materially helps a human answer "what changed." We do not need to capture the maximum possible diff payload at every checkpoint.

### 4. Favor low-friction UX

When a command is malformed, fail fast with a clear usage message instead of producing a misleading record.

### 5. Optimize for inspection

The audit trail should be easy to inspect in:

- `shared/tasks/<runId>/task.json`
- `shared/tasks/<runId>/steps.ndjson`
- `shared/tasks/<runId>/artifacts/*.json`
- `shared/tasks/<runId>/patches/*.patch`
- `shared/scratchpad.txt`
- `shared/runs.ndjson`

## Workstream 1: Make Step-Scoped Forks Real

### Problem

Today the optional `stepId` in the `fork` command is metadata only. The helper chooses a general representative snapshot instead of the named step's snapshot.

### Desired behavior

If `stepId` is provided:

- look for snapshots attached to that step first
- prefer `post-step`
- then `pre-step`
- if no matching snapshot exists, throw a clear error

If `stepId` is not provided:

- keep the current run-level representative snapshot behavior

### Implementation

Update `src/cli-audit.js`:

- add a helper like `selectSnapshotForFork(artifacts, { stepId })`
- when `stepId` is provided, filter to artifacts with `data.stepId === stepId`
- prefer scopes in this order:
  - `post-step`
  - `pre-step`
  - `run-end`
  - `run-start`
- fail with a specific error if the named step has no usable snapshot

Optional sanity check:

- read `steps.ndjson` or the task record and verify the step id existed in the source run
- this is helpful, but not required for the first fix if artifact filtering already gives a precise failure

### Tests

Add or update tests in:

- `tests/cli-audit.test.js`

Cover:

- step-specific fork chooses the step's `post-step` snapshot
- fallback to the step's `pre-step` snapshot if no `post-step` exists
- missing step snapshot throws a clear error
- run-level fork behavior remains unchanged when no `stepId` is passed

### Acceptance criteria

- a fork that names `implement-2` never silently inherits an unrelated later run snapshot
- the forked task's `baseCommit` is derived from the selected step-scoped snapshot

## Workstream 2: Only Record Artifacts That Actually Persisted

### Problem

The runtime currently attaches snapshot and fork artifact references to the in-memory run record even when artifact persistence fails.

### Desired behavior

If an artifact write fails:

- do not expose that artifact id in `run.worktreeSnapshots`
- do not expose that artifact id in `run.forkRecord`
- keep the overall run alive
- record a warning in logs and, where useful, in the scratchpad/run record

### Implementation

Refactor `src/orchestrator.js`:

1. Change `writeArtifactSafe()` to return a boolean or structured result:
   - `{ ok: true }`
   - `{ ok: false, error: "..." }`

2. Update `captureAndPersistWorktreeSnapshot()`:
   - only push to `run.worktreeSnapshots` if the artifact write succeeded
   - optionally still return a lightweight status object with an error field for internal use

3. Update `writeForkRecordIfPresent()`:
   - only assign `run.forkRecord` after a successful artifact write

4. Consider adding a runtime warning collection on `run`, for example:
   - `run.auditWarnings`

This is optional, but it gives the scratchpad a clean place to surface persistence failures without inventing fake artifact ids.

### Tests

Update:

- `tests/orchestrator/artifacts.js`

Cover:

- failed snapshot artifact write does not add a snapshot summary entry
- failed fork artifact write does not populate `run.forkRecord`
- the run still completes or fails according to the real task outcome, not the audit-write failure

### Acceptance criteria

- every artifact id shown in the scratchpad or run log actually exists on disk

## Workstream 3: Trim Snapshot Cost Without Losing Audit Value

### Problem

We currently capture full patch text for both `pre-step` and `post-step` snapshots, which duplicates a lot of data and can slow down write-enabled loops.

### Desired behavior

Keep:

- full patch capture for `post-step`
- lightweight state capture for `pre-step`

For `pre-step`, record enough to answer:

- was the repo already dirty
- which files were already changed
- were there untracked files
- what commit were we starting from

But do not require a full patch blob unless there is a strong reason.

### Recommended simplification

Change `src/worktree-audit.js` and `src/orchestrator.js` so that:

- `pre-step` captures:
  - `statusPorcelain`
  - `changedFiles`
  - `untrackedFiles`
  - `gitHead`
  - `gitHeadShort`
  - `dirty`
- `pre-step` does not write `patchText` or `stagedPatchText` by default
- `post-step` continues to persist patch files
- `run-start` and `run-end` can keep their current behavior unless later profiling shows they are too heavy

### Optional future refinement

If needed later, add a capture mode parameter:

- `metadata-only`
- `with-patch`

That is cleaner than encoding this behavior implicitly by scope everywhere.

### Tests

Update:

- `tests/worktree-audit.test.js`
- `tests/orchestrator/artifacts.js`

Cover:

- `pre-step` snapshots omit patch files
- `post-step` snapshots still persist patch files
- changed-file metadata remains available for both

### Acceptance criteria

- write-enabled loops still answer "what changed"
- average snapshot payload is meaningfully smaller for dirty repos

## Workstream 4: Tighten `fork` CLI Validation

### Problem

Unknown flags are currently treated as positional arguments, which can create bad lineage records.

### Desired behavior

For `fork`:

- only accept:
  - `<runId>`
  - optional `[stepId]`
  - optional `--reason "text"`
  - optional `--run`
- reject unknown flags
- reject extra positionals
- produce one clear usage message

### Implementation

Update `src/cli-commands.js`:

- in `parseForkArgs()`, detect any token starting with `-` that is not:
  - `--run`
  - `--reason`
- throw usage immediately for unknown flags

This is a small fix, but it improves user trust in the generated audit record.

### Tests

Update:

- `tests/cli.test.js`

Cover:

- `fork run-001 --bogus` fails with usage
- `fork run-001 step-1 extra` fails with usage
- valid existing forms still work

### Acceptance criteria

- malformed fork commands fail cleanly instead of silently reshaping the lineage

## Workstream 5: Reduce Scratchpad Duplication

### Problem

The scratchpad currently shows:

- a global `WORKTREE SNAPSHOTS` section
- per-step before/after snapshot references

That is helpful for completeness, but noisy for humans and costly when scratchpad text is later reused as context.

### Desired behavior

Keep the scratchpad readable and compact while preserving enough audit guidance.

### Recommended change

Use this split:

- keep the global `WORKTREE SNAPSHOTS` section as the audit index
- in each step section, show only the most important local pointer

Recommended per-step display:

- `Worktree Before: dirty|clean`
- `Worktree After Patch: patches/...` only when a post-step patch exists

Or, even simpler:

- remove per-step snapshot artifact ids entirely
- keep only the per-step `Worktree After Patch`

That preserves the answer to "who changed what where" without duplicating the entire snapshot directory structure in every step block.

### Implementation

Update `src/orchestrator.js` in `renderScratchpad()`:

- keep one authoritative summary block
- trim per-step lines to the minimum human-useful subset

### Tests

Update:

- `tests/orchestrator/artifacts.js`

Cover:

- scratchpad still exposes patch references for write-enabled steps
- duplicate low-value snapshot lines are removed

### Acceptance criteria

- scratchpad stays useful as a human summary
- scratchpad becomes shorter for multi-step runs

## Recommended Commit Sequence

1. `audit: make fork step lineage select matching snapshots`
2. `audit: only surface persisted artifact references`
3. `audit: make pre-step snapshots metadata-only`
4. `cli: reject unknown fork flags and extra arguments`
5. `audit: trim duplicate scratchpad snapshot output`
6. `tests/docs: update coverage and audit documentation`

## Suggested Implementation Order

### Phase 1: correctness first

- Workstream 1
- Workstream 2
- Workstream 4

These directly improve trust in the audit trail.

### Phase 2: efficiency and polish

- Workstream 3
- Workstream 5

These reduce cost and improve readability without changing the feature's core purpose.

## Docs To Update After Code Changes

If behavior changes materially, update:

- `README.md`
- `docs/cli.md`
- `docs/config.md`
- `AGENTS.md`

Focus on:

- how `fork <runId> [stepId]` now behaves
- what `pre-step` vs `post-step` snapshots contain
- what users should expect to find in the scratchpad and artifacts

## Non-Goals For This Follow-Up

This plan does not add:

- automatic run replay
- automatic branch creation
- semantic diffing
- UI compare dashboards
- step-by-step blame attribution beyond the current Git-backed record model

## Definition Of Done

This follow-up is complete when:

- named-step forks use named-step evidence
- artifact references in logs and scratchpads always correspond to real files
- `pre-step` snapshots are materially lighter than `post-step` snapshots
- malformed fork commands fail clearly
- the scratchpad is shorter without becoming less useful
- the relevant tests are green

