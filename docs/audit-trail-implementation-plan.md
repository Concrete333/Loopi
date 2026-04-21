# Audit Trail Implementation Plan

## Goal

Add a lightweight, human-readable audit trail that lets someone go back through a Dialectic run and answer:

- who did what
- when they did it
- what files changed
- where the edits landed
- how one run compares to another
- what prior run a later attempt forked from

The design goal is to provide a durable record, not a full automation system.

## Non-Goals

This plan does **not** try to add:

- automatic replay of an old run
- automatic rollback or branch creation
- perfect per-step attribution in a dirty repository
- UI dashboards
- Git commit automation

Git remains the underlying source of truth for file edits. Dialectic adds structured run-linked snapshots around that truth.

## Why This Approach

Dialectic already records:

- run identity
- step identity
- agent name
- stage name
- timestamps
- cycle number
- write-enabled vs read-only execution
- step output and handoff data

That means the missing layer is not "who" or "when." The missing layer is the state of the working tree at key moments.

The simplest efficient solution is:

1. keep Git as the edit truth
2. capture lightweight worktree snapshots at important moments
3. attach those snapshots to the existing run/task/step model
4. make fork lineage explicit through a small metadata artifact

## Current Baseline In The Codebase

### Existing run records

Dialectic already writes:

- `shared/scratchpad.txt`
- `shared/log.json`
- `shared/runs.ndjson`
- `shared/tasks/<runId>/task.json`
- `shared/tasks/<runId>/steps.ndjson`
- `shared/tasks/<runId>/artifacts/*.json`

### Existing modules we should extend

- `src/orchestrator.js`
- `src/collaboration-store.js`
- `src/task-paths.js`
- `src/artifact-types.js`
- `src/artifact-schemas.js`

### Existing step fields we can build on

Every step already records:

- `id`
- `stage`
- `agent`
- `startedAt`
- `finishedAt`
- `ok`
- `durationMs`
- `cycleNumber`
- `canWrite`
- `usedFallback`
- `fallbackReason`
- `warnings`
- `capabilityDowngrades`

That is enough to connect a worktree snapshot to a specific run step.

## Proposed MVP

Add a new Git-backed audit record at:

- run start
- after every write-enabled step
- run end

That gives humans a durable history with very little orchestration complexity.

### Core principle

We are recording **workspace state after important events**, not trying to prove perfect causality in every edge case.

If the repo is already dirty at run start, the trail should say so explicitly.

## Data Model

## New artifact type: `worktree-snapshot`

Add a new JSON artifact type:

- `worktree-snapshot`

Purpose:

- record the Git-visible state of the repository at a point in time
- tie that state to a run and optionally a specific step

### Proposed schema

```json
{
  "type": "worktree-snapshot",
  "id": "worktree-snapshot-0001",
  "taskId": "run-2026-04-21T12-34-56-789Z",
  "createdAt": "2026-04-21T12:35:12.000Z",
  "cycleNumber": 1,
  "data": {
    "scope": "run-start",
    "stepId": null,
    "stage": null,
    "agent": null,
    "canWrite": false,
    "gitAvailable": true,
    "gitHead": "abc123...",
    "gitHeadShort": "abc1234",
    "statusPorcelain": [
      " M src/orchestrator.js",
      "?? shared/tmp.txt"
    ],
    "changedFiles": [
      {
        "status": "M",
        "path": "src/orchestrator.js",
        "previousPath": null
      }
    ],
    "untrackedFiles": [
      "shared/tmp.txt"
    ],
    "patchFile": "patches/worktree-snapshot-0001.patch",
    "stagedPatchFile": "patches/worktree-snapshot-0001.staged.patch",
    "dirty": true,
    "captureError": null
  }
}
```

### `scope` values

- `run-start`
- `post-step`
- `run-end`
- `manual-fork`

These are enough for the MVP and future fork lineage support.

## New artifact type: `fork-record`

This is optional for phase 2, but the schema should be planned now.

Purpose:

- record that a later task/run was manually forked from an earlier one
- preserve lineage without automating replay

### Proposed schema

```json
{
  "type": "fork-record",
  "id": "fork-record-0001",
  "taskId": "run-2026-04-25T10-15-00-000Z",
  "createdAt": "2026-04-25T10:15:05.000Z",
  "data": {
    "forkedFromRunId": "run-2026-04-21T12-34-56-789Z",
    "forkedFromStepId": "implement-4",
    "baseCommit": "abc123...",
    "reason": "Retry with different reviewer and more implement loops",
    "recordedBy": "manual"
  }
}
```

## Patch File Storage

The collaboration store currently validates JSON artifacts only. Full diffs should therefore be stored as sibling files, not embedded inline inside artifact JSON.

### Proposed layout

Inside `shared/tasks/<runId>/`:

- `task.json`
- `steps.ndjson`
- `artifacts/*.json`
- `patches/*.patch`

### New task path helpers

Extend `src/task-paths.js` with:

- `patchesDir(projectRoot, taskId)`
- `patchFilePath(projectRoot, taskId, snapshotId, kind = 'worktree')`

Suggested naming:

- `patches/<snapshotId>.patch`
- `patches/<snapshotId>.staged.patch`

## Git Commands To Capture

For each snapshot, run:

- `git rev-parse HEAD`
- `git status --porcelain=v1 --untracked-files=all`
- `git diff --name-status --find-renames HEAD`
- `git diff --binary --no-color HEAD`
- `git diff --cached --binary --no-color HEAD`

Optional later:

- `git rev-parse --abbrev-ref HEAD`
- `git ls-files --others --exclude-standard`

### Why these commands

- `rev-parse HEAD`: gives a stable base commit
- `status --porcelain`: gives a parseable dirty-state summary
- `diff --name-status`: gives a quick human scan of what changed
- `diff --binary`: preserves enough detail for manual replay/comparison
- `diff --cached`: records staged changes separately if the user staged anything mid-run

## New module: `src/worktree-audit.js`

Create a focused module responsible for Git inspection.

### Responsibilities

- detect whether the project root is inside a Git repo
- run the snapshot commands
- normalize command output into:
  - `gitHead`
  - `statusPorcelain`
  - `changedFiles`
  - `untrackedFiles`
  - `patchText`
  - `stagedPatchText`
- fail soft when Git is missing or the repo is unavailable

### Suggested API

```js
async function captureWorktreeSnapshot({
  projectRoot,
  scope,
  step = null
})
```

Returns:

```js
{
  scope,
  stepId,
  stage,
  agent,
  canWrite,
  gitAvailable,
  gitHead,
  gitHeadShort,
  statusPorcelain,
  changedFiles,
  untrackedFiles,
  patchText,
  stagedPatchText,
  dirty,
  captureError
}
```

### Implementation notes

- Use `spawn` or `spawnSync` through a small helper in this module
- Do not shell through `cmd /c`
- Reuse existing style from `src/run-lock.js` / `src/adapters/index.js`
- Treat Git absence as a valid state, not a fatal runtime error

## Orchestrator Hook Points

## 1. Run start snapshot

Hook in `runTask()` after:

- config normalization
- task record creation

But before:

- actual execution begins

This captures the baseline state for the run.

### Why here

- we want a reference point for later comparison
- we want to know whether the repo was already dirty

## 2. Post-step snapshot for write-enabled steps

Hook in `runStep()` after:

- the step result has been assembled
- the step has been appended to `run.steps`
- the step has been recorded in `steps.ndjson`

Only capture when:

- `step.canWrite === true`

### Why only write-enabled steps

- read-only review/plan steps do not intentionally change files
- this keeps the audit trail cheap and focused

### Why post-step rather than before-and-after in MVP

- simpler
- half the capture overhead
- enough for a human to see the state after a write action
- run-start baseline already gives the initial anchor

## 3. Run end snapshot

Hook in `runTask()` in the `finally` path after run completion/failure is known and before final scratchpad/writeout completes.

This gives:

- final state of the workspace
- the easiest artifact for comparing two runs manually

## Artifact writing flow

For each snapshot:

1. capture Git state
2. allocate a new snapshot artifact id
3. write `.patch` and `.staged.patch` files if non-empty
4. write the JSON `worktree-snapshot` artifact with relative patch paths

If Git capture fails:

- still write the JSON artifact
- set `gitAvailable: false` or `captureError`
- do not abort the run

## Scratchpad additions

Do not dump full diffs into `shared/scratchpad.txt`.

Instead add short references for write-enabled steps:

- `Worktree Snapshot: artifacts/worktree-snapshot-0002.json`
- `Patch: patches/worktree-snapshot-0002.patch`

And optionally at run end:

- `Final Worktree Snapshot: artifacts/worktree-snapshot-0004.json`

This keeps the scratchpad readable while still pointing humans to the audit files.

## Run log additions

The existing `runs.ndjson` already stores the full `run` object. Do not inline patch content there.

Optional small additions to run-level structure:

- `worktreeSnapshotIds: []`

This is not required for MVP because the artifact store can already be enumerated by type, but it may improve discoverability later.

## Manual fork lineage

This does not need automation in phase 1.

### Phase 1 record-only option

Allow a human to create a `fork-record` artifact manually or via a small helper command later.

Minimum useful data:

- source run id
- source step id
- base commit
- note/reason

### Suggested future CLI

Not in MVP, but planned:

```powershell
npm run cli -- fork --from-run <runId> --from-step <stepId>
```

This could:

- copy or update `shared/task.json`
- write a `fork-record` artifact
- optionally annotate the scratchpad

## Manual comparison workflow

The MVP should support comparison without any new automation.

Humans should be able to:

1. open `shared/tasks/<runA>/artifacts/` and `shared/tasks/<runB>/artifacts/`
2. compare `run-end` snapshot JSON files
3. diff `patches/<snapshotId>.patch` across runs
4. compare `steps.ndjson` to see which agent/stage sequence produced each state

This is enough to support:

- "what did run A change that run B did not?"
- "which write-enabled step introduced this file change?"
- "which agent was responsible for the last write-enabled state?"

## Phase Breakdown

## Phase 1: Worktree snapshots

Implement:

- `src/worktree-audit.js`
- new task path helpers for patches
- new artifact type: `worktree-snapshot`
- schema validation
- run-start snapshot
- post-write-step snapshot
- run-end snapshot
- patch file writing
- scratchpad links to snapshot files

### Acceptance criteria

- every run writes a run-start snapshot artifact
- every write-enabled step writes a post-step snapshot artifact
- every run writes a run-end snapshot artifact
- each snapshot records Git HEAD and changed file list when Git is available
- each snapshot writes a patch file when there is a diff
- runs do not fail when Git is absent or broken

## Phase 2: Fork lineage record

Implement:

- new artifact type: `fork-record`
- schema validation
- minimal helper for recording fork metadata

### Acceptance criteria

- a later run can point back to an earlier run/step
- lineage is visible by reading artifacts only

## Phase 3: Optional usability improvements

Possible later work:

- before-step plus after-step snapshots for exact per-step delta
- CLI helper to print audit trail summaries
- README/docs section on audit history
- side-by-side run comparison helper

## Commit-By-Commit Plan

This section translates the design into a reviewable implementation sequence.

The goal is to keep each commit:

- small enough to review comfortably
- meaningful on its own
- low-risk to merge
- easy to test before moving to the next step

## Commit 1: Add new artifact types and schema support

### Purpose

Teach the artifact system about audit-trail records before adding any runtime behavior.

### Changes

- Update `src/artifact-types.js`
  - add `worktree-snapshot`
  - add `fork-record`
- Update `src/artifact-schemas.js`
  - add `validateWorktreeSnapshotData`
  - add `validateForkRecordData`
  - wire both into `validateArtifactData(...)`

### Notes

No orchestration changes yet.

No new files should be written at runtime in this commit.

### Tests

Add or extend schema tests so valid and invalid examples for both artifact types are covered.

### Acceptance criteria

- artifact validation accepts valid `worktree-snapshot` artifacts
- artifact validation rejects malformed `worktree-snapshot` artifacts
- artifact validation accepts valid `fork-record` artifacts
- artifact validation rejects malformed `fork-record` artifacts

## Commit 2: Add task-path helpers for patch storage

### Purpose

Add first-class path helpers for non-JSON patch files under each run directory.

### Changes

- Update `src/task-paths.js`
  - add `patchesDir(projectRoot, taskId)`
  - add `patchFilePath(projectRoot, taskId, snapshotId, suffix = '')`
- export the new helpers

### Notes

This commit still does not capture Git state.

It only gives the later runtime code a safe place to write patch files.

### Tests

Add focused tests for:

- patch directory path generation
- patch file path generation
- safe snapshot id handling

### Acceptance criteria

- new helpers build paths under `shared/tasks/<runId>/patches/`
- unsafe snapshot ids are rejected

## Commit 3: Add `src/worktree-audit.js`

### Purpose

Introduce a dedicated Git inspection module without wiring it into the orchestrator yet.

### Changes

- add `src/worktree-audit.js`
- implement helpers to:
  - detect whether Git is available
  - detect whether `projectRoot` is inside a Git repo
  - run Git commands safely without `cmd /c`
  - collect:
    - `gitHead`
    - `gitHeadShort`
    - `statusPorcelain`
    - `changedFiles`
    - `untrackedFiles`
    - `patchText`
    - `stagedPatchText`
    - `dirty`
    - `captureError`
- export a single top-level capture function, e.g.:

```js
captureWorktreeSnapshot({ projectRoot, scope, step })
```

### Notes

This commit is pure infrastructure. Nothing in `orchestrator.js` should call it yet.

### Tests

Add `tests/worktree-audit.test.js` with coverage for:

- Git available in a repo
- non-Git directory
- Git executable missing or failing
- empty diff
- non-empty diff
- parsing of `git status --porcelain`
- rename handling from `git diff --name-status --find-renames`

### Acceptance criteria

- `captureWorktreeSnapshot(...)` returns normalized data
- failures become `captureError`, not thrown fatal runtime errors

## Commit 4: Add snapshot artifact builders and patch persistence helpers

### Purpose

Add the code that turns raw Git-capture output into Dialectic artifacts and patch files.

### Changes

- Update `src/orchestrator.js`
  - add `buildWorktreeSnapshotArtifact(...)`
  - add helper(s) to persist patch files under `shared/tasks/<runId>/patches/`
  - add helper(s) to capture and write a snapshot without yet calling them from run flow
- Optionally add a small helper in `src/collaboration-store.js`
  - `writePatchFile(...)`
  - only if it makes the implementation cleaner

### Notes

This commit still should not change run behavior.

It prepares reusable helpers for later wiring.

### Tests

Add focused tests for:

- artifact builder output shape
- relative patch path handling in artifact data
- patch file writing to the expected run-local location

### Acceptance criteria

- snapshot artifact builder produces schema-valid artifacts
- patch helper writes files to the expected path

## Commit 5: Capture run-start snapshots

### Purpose

Record the baseline repository state at the beginning of every run.

### Changes

- Update `src/orchestrator.js`
  - in `runTask()`, after config normalization and initial task record creation, capture a `run-start` worktree snapshot
  - write any corresponding patch files
  - write the JSON artifact to the collaboration store

### Notes

This is the first runtime-visible audit commit.

Do not add post-step or run-end behavior yet.

### Tests

Extend orchestrator tests to verify:

- a run-start snapshot is written once per run
- snapshot creation failure does not fail the run
- non-Git repos still complete with a snapshot artifact containing `captureError` or `gitAvailable: false`

### Acceptance criteria

- every run writes a baseline `run-start` snapshot artifact
- runs still succeed when Git is unavailable

## Commit 6: Capture run-end snapshots

### Purpose

Record final repository state at the end of every run, regardless of success or failure.

### Changes

- Update `src/orchestrator.js`
  - in the `finally` path of `runTask()`, capture a `run-end` snapshot
  - write patch files and artifact JSON

### Notes

This commit makes run-to-run comparison viable even before per-write-step capture exists.

### Tests

Extend orchestrator tests to verify:

- run-end snapshot exists after a successful run
- run-end snapshot exists after a failed run
- run-start and run-end snapshots can coexist in one task folder

### Acceptance criteria

- every run produces both `run-start` and `run-end` snapshots

## Commit 7: Capture post-step snapshots for write-enabled steps

### Purpose

Record the repository state after any step that was allowed to write.

### Changes

- Update `src/orchestrator.js`
  - after `appendStep(...)` succeeds and the step is added to `run.steps`, capture a `post-step` snapshot when `step.canWrite === true`
  - include:
    - `stepId`
    - `stage`
    - `agent`
    - `cycleNumber`
    - `canWrite`

### Notes

This is the commit that enables the practical “who did what where” trace for edit-capable steps.

Read-only steps should not generate post-step snapshots in the MVP.

### Tests

Extend orchestrator tests to verify:

- write-enabled steps create post-step snapshots
- read-only steps do not create post-step snapshots
- multiple write-enabled steps create multiple snapshots in order

### Acceptance criteria

- only write-enabled steps produce `post-step` worktree snapshots
- post-step artifacts are linked to the correct `stepId`, `stage`, and `agent`

## Commit 8: Add scratchpad references to audit artifacts

### Purpose

Make the audit trail discoverable by humans without requiring them to inspect the directory tree blindly.

### Changes

- Update `src/orchestrator.js`
  - extend `renderScratchpad(run)` so write-enabled steps can reference their snapshot artifact and patch file
  - optionally add a final section listing:
    - run-start snapshot
    - run-end snapshot

### Notes

Do not embed patch content into the scratchpad.

Only include paths or compact references.

### Tests

Add scratchpad rendering assertions to verify:

- write-enabled steps show snapshot references
- scratchpad stays readable
- missing patch files do not break rendering

### Acceptance criteria

- a human reading `shared/scratchpad.txt` can discover the audit files without manual guesswork

## Commit 9: Add `fork-record` support

### Purpose

Add a lightweight lineage record for manually forked runs.

### Changes

- Update the runtime or helper layer to allow writing a `fork-record` artifact
- minimum implementation can be a small helper function only

Suggested helper:

```js
writeForkRecord({
  runId,
  forkedFromRunId,
  forkedFromStepId,
  baseCommit,
  reason
})
```

### Notes

This commit does not need CLI automation.

It only needs the ability to persist lineage metadata cleanly.

### Tests

Add schema and write-path tests for valid `fork-record` creation.

### Acceptance criteria

- a later run can record that it was manually forked from an earlier run/step

## Commit 10: Documentation pass

### Purpose

Explain the new audit trail to users and future maintainers.

### Changes

- Update `README.md`
  - mention that runs now record worktree snapshots and patch artifacts
- Update `AGENTS.md` if needed
  - short note for AI agents navigating the run output
- Update docs
  - add or link an audit-trail usage section

### Notes

Keep the README summary high level.

Deeper operational details should live in docs.

### Acceptance criteria

- public docs explain where the audit files live and what they mean

## Commit 11: Optional refinement pass

### Purpose

Clean up naming, error messages, and any rough edges discovered during manual testing.

### Possible changes

- normalize artifact ids and patch file names
- improve `captureError` text
- reduce duplicate logic between run-start/run-end/post-step capture paths
- improve scratchpad wording

### Acceptance criteria

- no functional change, just polish

## Recommended merge/checkpoint strategy

If you want the lowest-risk path, stop and verify after:

- Commit 3
- Commit 6
- Commit 8

Those are the points where:

- the Git module exists
- run-level snapshots are already useful
- the feature becomes discoverable to humans

## Smallest viable stopping point

If you need the absolute smallest version that is still useful, stop after:

- Commit 1
- Commit 2
- Commit 3
- Commit 5
- Commit 6

That gives you:

- baseline state per run
- final state per run
- manual comparison between runs

The true “who changed what after a write step” value starts at Commit 7.

## File-Level Implementation Tasks

## `src/artifact-types.js`

Add:

- `worktree-snapshot`
- `fork-record`

## `src/artifact-schemas.js`

Add validators:

- `validateWorktreeSnapshotData`
- `validateForkRecordData`

The schema should allow:

- `captureError` to be `null` or string
- `patchFile` / `stagedPatchFile` to be `null` or string
- `statusPorcelain`, `changedFiles`, `untrackedFiles` to be arrays

## `src/task-paths.js`

Add:

- `patchesDir(projectRoot, taskId)`
- `patchFilePath(projectRoot, taskId, snapshotId, suffix = '')`

Ensure safe path segment checks are reused.

## `src/collaboration-store.js`

No major structural changes needed if patch files are written outside JSON artifact handling.

Optional helper:

- `writePatchFile(taskId, snapshotId, text, { staged })`

This is optional. The orchestrator can also write patch files directly using task paths.

## `src/worktree-audit.js`

New module with:

- Git process helper
- parsing helpers
- snapshot capture function
- changed-file normalization

## `src/orchestrator.js`

Add:

- helper to build `worktree-snapshot` artifact JSON
- helper to capture and persist a snapshot
- hook in `runTask()` for run-start
- hook in `runStep()` for write-enabled steps
- hook in `runTask()` finally block for run-end
- scratchpad references to created snapshot files

## Tests

## Unit tests

Create:

- `tests/worktree-audit.test.js`

Test:

- Git available path
- non-Git directory path
- Git command failure path
- parsing `status --porcelain`
- patch capture with empty vs non-empty diff

## Schema tests

Extend:

- `tests/collaboration-store.test.js` or new artifact-schema coverage

Test:

- valid `worktree-snapshot`
- invalid fields rejected
- valid `fork-record`
- invalid fields rejected

## Orchestrator tests

Add tests to confirm:

- run-start snapshot is written once per run
- write-enabled step snapshot is written only for write-enabled steps
- read-only steps do not create write-step snapshots
- run-end snapshot is written on success
- run-end snapshot is written on failure
- Git absence does not fail the run

## Manual verification checklist

1. Start from a clean Git repo and run a write-enabled implement task.
2. Confirm:
   - run-start snapshot exists
   - post-step snapshot exists
   - run-end snapshot exists
   - `.patch` file exists and contains the expected diff
3. Start from a dirty repo and repeat.
4. Confirm the baseline snapshot marks the repo dirty.
5. Run a read-only review task.
6. Confirm only run-start and run-end snapshots exist.

## Risks And Tradeoffs

## 1. Dirty repo attribution is imperfect

This MVP records state, not mathematically perfect blame.

Mitigation:

- capture run-start baseline
- capture post-write snapshots
- surface `dirty` clearly

## 2. Patch files can be large

Large diffs will increase disk usage.

Mitigation:

- keep MVP simple and accept the cost
- add future size caps or compression only if real usage demands it

## 3. Git may be missing or unavailable

Mitigation:

- fail soft
- write snapshot artifacts with `captureError`
- never abort the run because Git inspection failed

## 4. Snapshot timing is post-step only

This means the artifact answers:

- "what did the repo look like after this write-enabled step?"

more directly than:

- "what exact isolated delta belongs only to this one step?"

That tradeoff is acceptable for the MVP.

## Recommendation

Build phase 1 first and stop there until people use it.

Phase 1 already solves the practical problem:

- a human can review a run
- see which agent and stage wrote
- inspect the repository state after that write
- compare final states across runs
- manually fork from a prior point with enough context to do it responsibly

That is the simplest efficient implementation that fits Dialectic's current architecture.
