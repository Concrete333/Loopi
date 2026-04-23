# Plug And Play Mid Patch Plan

## Status

Completed.

This mid-patch plan has been implemented in `LoopiDev` and the relevant automated tests are green. The remaining work is future feature development rather than unfinished mid-patch remediation.

## Goal

Address the Phase 4 review findings in a way that improves user trust and lowers future UI complexity:

- never hide broken task state from the user
- make the run dashboard reflect real runtime state instead of blocking on a long request
- make run history resilient when data is missing or partially damaged
- keep validation feedback honest as the draft changes
- simplify the control-plane contract so the UI is easier to reason about and maintain

This plan assumes we keep the current dependency-free browser UI and control-plane service approach. The goal is to fix the current model, not replace it with a frontend framework.

## Findings This Plan Addresses

1. Corrupt `shared/task.json` files are masked by the UI and can be overwritten by accident.
2. `Run Now` is synchronous, so the dashboard cannot observe a run while it is actually running.
3. Missing or damaged run records can break or disappear from the dashboard instead of surfacing as recoverable error states.
4. Validation success/error banners become stale after subsequent edits.
5. The control-plane API shape is inconsistent, which adds branching and fragility in the UI layer.
6. The browser app is already large enough that state and rendering concerns are starting to bleed together.

## Design Principles

### 1. Never replace evidence with a default

If a task file is invalid, the UI must say so explicitly. Do not silently swap in `defaultConfig()` in any path that represents persisted state.

### 2. Treat runs as long-lived jobs, not RPC calls

Launching a run and observing a run are different operations. The control plane should model them separately.

### 3. Degrade visibly, not invisibly

If a stored run cannot be read completely, show that the run is damaged or incomplete. Do not quietly drop it from history.

### 4. Validation is a snapshot, not a truth flag

Any edit to the draft config should invalidate previous validation status until the user validates again.

### 5. One API envelope

All UI-facing control-plane endpoints should return the same response shape so the browser code does not need special cases.

### 6. Split by responsibility before adding more features

Fix the current state flow and file boundaries now, while the UI is still small enough to refactor safely.

## Read First

Before making changes, read these files in this order:

1. `src/control-plane/index.js`
2. `src/control-plane/server.js`
3. `apps/ui/public/app.js`
4. `src/collaboration-store.js`
5. `src/orchestrator.js`
6. `tests/control-plane.test.js`
7. `tests/ui-server.test.js`

## Workstream 1: Make Invalid Persisted Config State First-Class

### Problem

The UI treats a failed config load as a cue to fall back to a clean draft. That makes a broken persisted file look safe and editable.

### Root cause

The current UI state model does not distinguish:

- "no task file exists yet"
- "task file exists and is valid"
- "task file exists and is invalid"

The browser only keeps a single editable draft object, so persisted-state errors are collapsed into defaults too early.

### Desired behavior

When `shared/task.json` is invalid:

- the UI shows a clear persisted-config error banner
- the raw invalid file contents remain available to inspect
- normal save/run actions are disabled until the user explicitly resolves or replaces the invalid config
- the user can still start from a new draft, but only through an explicit action such as `Start New Draft`

### Edit these files

- `src/control-plane/index.js`
- `src/control-plane/server.js`
- `apps/ui/public/app.js`
- `tests/control-plane.test.js`
- `tests/ui-server.test.js`

### Implementation

1. Extend `ControlPlaneService.loadConfig()` in `src/control-plane/index.js` so it always returns a stable persisted-config status object.
   Include:
   - `exists`
   - `valid`
   - `filePath`
   - `raw`
   - `rawText`
   - `normalized`
   - `error`

2. In `src/control-plane/index.js`, preserve the raw file text when JSON parsing fails.
   Do not discard the file contents on invalid JSON.

3. In `apps/ui/public/app.js`, replace the single persisted-config assumption with separate state for:
   - persisted config metadata
   - editable draft config
   - persisted-config error state

4. Add an explicit transition in the UI for "use persisted config as draft" versus "start fresh draft".
   Do not auto-promote defaults when the persisted file is invalid.

5. Add UI messaging in the Settings or Composer surface that explains exactly what happened and where the invalid file lives.

### Do not do this

- Do not silently call `defaultConfig()` to represent a broken persisted file.
- Do not auto-overwrite an invalid task file on page load.
- Do not hide the invalid raw text behind advanced-only controls if it is the reason the app is blocked.

### Tests

Add or update tests in:

- `tests/control-plane.test.js`
- `tests/ui-server.test.js`

Cover:

- invalid JSON task file returns `rawText` and `valid: false`
- missing task file is distinct from invalid task file
- UI bootstrap/config endpoints expose enough information to render the invalid-state path

### Done when

- a malformed `shared/task.json` is always visible as malformed
- the UI never presents a broken persisted file as a clean saved draft
- the user must take an explicit action before replacing invalid persisted config

## Workstream 2: Introduce Real Run Sessions Instead Of Blocking Launch Calls

### Problem

`Run Now` is implemented as a blocking request that returns only after orchestration finishes, so the dashboard cannot show live progress.

### Root cause

The control plane currently treats run launch, execution, and completion as one synchronous API action. The browser has no separate concept of a live run session.

### Desired behavior

Running a task should be split into:

- a quick launch request that returns a `runId` immediately
- a run-status/read-model that the dashboard can refresh or poll
- a dashboard that can show `queued`, `running`, `completed`, and `failed`

### Edit these files

- `src/control-plane/index.js`
- `src/control-plane/server.js`
- `src/orchestrator.js`
- `src/collaboration-store.js`
- `apps/ui/public/app.js`
- `tests/control-plane.test.js`
- `tests/ui-server.test.js`
- `tests/collaboration-store.test.js`

### Implementation

1. Add an in-process run session manager in `src/control-plane/index.js`.
   It should:
   - start orchestrator work in the background
   - track run session state by `runId`
   - expose status transitions cleanly

2. Create a dedicated launch method in `src/control-plane/index.js`, for example `launchRunSession()`, that:
   - validates or saves the draft config first
   - starts the orchestrator asynchronously
   - returns immediately with `runId`, initial status, and any saved config metadata

3. Add UI-facing endpoints in `src/control-plane/server.js` for:
   - launch
   - session status
   - optional session list or active-run view

4. Ensure `src/orchestrator.js` continues writing durable artifacts through `collaboration-store.js`.
   The session manager is for live state, not a replacement for persisted run data.

5. In `apps/ui/public/app.js`, change `Run Now` so it:
   - launches the run
   - switches to the Runs tab or updates the dashboard
   - refreshes run status until the live session ends

6. Use a small, explicit polling loop in the browser.
   Keep it local to run monitoring and stop it cleanly when the active session finishes or the user switches away.

### Do not do this

- Do not keep the current long-lived POST and merely add spinner text.
- Do not store the only source of run truth in browser state.
- Do not make the dashboard depend on WebSockets or extra runtime dependencies for this patch.

### Tests

Add or update tests in:

- `tests/control-plane.test.js`
- `tests/ui-server.test.js`
- `tests/collaboration-store.test.js`

Cover:

- launch returns before the run finishes
- live run status transitions to completed or failed
- persisted run data is still readable after completion
- failed launches are distinct from failed runs

### Done when

- `Run Now` returns control quickly
- the dashboard can represent an in-flight run
- run completion is visible through both live status and persisted artifacts

## Workstream 3: Make Run History Resilient To Missing Or Damaged Data

### Problem

Missing or unreadable runs either disappear from the list or can break detail rendering.

### Root cause

The service layer collapses run-list read failures into `continue`, and the UI assumes run details are structurally complete once fetched.

### Desired behavior

If a run directory or artifact is damaged:

- the run still appears in history when possible
- the summary shows that the run is damaged or partial
- the detail view renders a recoverable error state instead of throwing

### Edit these files

- `src/control-plane/index.js`
- `apps/ui/public/app.js`
- `tests/control-plane.test.js`

### Implementation

1. Refactor `listRuns()` in `src/control-plane/index.js` so it produces a stable summary even when some run reads fail.
   Include fields such as:
   - `status`
   - `runId`
   - `readError`
   - `isDamaged`

2. Refactor `getRunDetails()` in `src/control-plane/index.js` so missing runs and damaged runs are different cases.
   Return a stable envelope that always includes:
   - `exists`
   - `isDamaged`
   - `error`
   - `summary`
   - `steps`
   - `artifacts`

3. In `apps/ui/public/app.js`, make the Runs tab tolerant of:
   - `summary === null`
   - missing artifacts
   - damaged runs with partial data

4. Render explicit empty/error panels instead of assuming nested properties exist.

### Do not do this

- Do not keep swallowing run read failures with `continue`.
- Do not fix only the specific `details.summary.status` dereference and leave the data model ambiguous.

### Tests

Add or update tests in:

- `tests/control-plane.test.js`

Cover:

- a damaged run still appears in `listRuns()`
- missing run details return a safe structured payload
- damaged run details return a safe structured payload with an error

### Done when

- run history never silently drops damaged entries without explanation
- the Runs tab does not crash on missing or partial run data

## Workstream 4: Make Validation State Derived And Honest

### Problem

Validation success/error messages stay on screen after the draft changes.

### Root cause

Validation state is stored as a durable flag in UI state, but edits do not invalidate it.

### Desired behavior

After any draft mutation:

- previous validation results are marked stale immediately
- the UI clearly distinguishes:
  - never validated
  - validated and current
  - validation stale because the draft changed

### Edit these files

- `apps/ui/public/app.js`
- `tests/ui-server.test.js`

### Implementation

1. Add a small draft-version or dirty-since-validation model in `apps/ui/public/app.js`.

2. Route all config mutations through a shared helper that:
   - updates the draft
   - increments draft version or marks validation stale
   - refreshes any dependent UI state

3. Change the validation banner rendering so it keys off:
   - validation result
   - validation version
   - current draft version

4. Ensure raw-editor apply paths and structured form paths share the same staleness behavior.

### Do not do this

- Do not clear only the green success banner but keep stale error text.
- Do not patch just one or two mutators; centralize the invalidation behavior.

### Tests

Add or update tests in:

- `tests/ui-server.test.js`

Cover:

- validating a draft marks it current
- editing any field after validation marks the validation stale
- applying raw JSON also marks validation stale

### Done when

- the UI never claims the current draft is valid based on an earlier version

## Workstream 5: Normalize The Control-Plane API Envelope

### Problem

The UI helper has to support multiple response shapes because `/api/bootstrap` differs from the rest of the API.

### Root cause

The control plane does not enforce one transport contract for UI-facing endpoints.

### Desired behavior

Every JSON endpoint should return the same envelope:

```json
{
  "ok": true,
  "data": {}
}
```

Or, on failure:

```json
{
  "ok": false,
  "error": "message"
}
```

### Edit these files

- `src/control-plane/server.js`
- `apps/ui/public/app.js`
- `tests/ui-server.test.js`

### Implementation

1. Update `src/control-plane/server.js` so every JSON endpoint, including `/api/bootstrap`, uses the same response envelope.

2. Simplify the `api()` helper in `apps/ui/public/app.js` so it only understands one response shape.

3. Remove any browser-side branching that exists only because of the envelope inconsistency.

### Do not do this

- Do not keep a special-case bootstrap parser.
- Do not mix transport-shape cleanup into unrelated UI refactors without tests.

### Tests

Add or update tests in:

- `tests/ui-server.test.js`

Cover:

- `/api/bootstrap` now returns `{ ok, data }`
- existing endpoints still return `{ ok, data }`
- error paths return `{ ok: false, error }`

### Done when

- the client has exactly one JSON API parsing path

## Workstream 6: Split The Browser App By Responsibility

### Problem

The single-file UI is getting large enough that behavior fixes are harder than they should be.

### Root cause

State, rendering, API calls, event binding, and screen-specific behavior all live in one immediately-invoked script.

### Desired behavior

Keep the dependency-free approach, but split the app into a few stable modules so future changes land in the right place.

### Edit these files

- `apps/ui/public/app.js`
- `apps/ui/public/index.html`
- optionally new files under `apps/ui/public/`
- `tests/ui-server.test.js`

### Implementation

1. Split the current browser code into a minimal module structure such as:
   - `state.js`
   - `api.js`
   - `render.js`
   - `actions.js`
   - `app.js`

2. Keep screen rendering grouped by feature area:
   - setup
   - settings
   - composer
   - runs

3. Move all draft mutation helpers into one module so Workstream 4 has a single place to live.

4. Keep the control-plane transport helper separate from DOM rendering logic.

5. Keep the split small and mechanical.
   This is a maintainability refactor, not a redesign.

### Do not do this

- Do not introduce a bundler, framework, or runtime dependency.
- Do not combine this with a visual redesign.
- Do not let the module split change endpoint behavior without corresponding tests.

### Tests

Update:

- `tests/ui-server.test.js`

Cover:

- the UI shell still serves correctly
- any new static assets required by the split are reachable

### Done when

- no single browser file owns all state, rendering, events, and API logic
- future UI fixes can target a smaller module instead of a 1,000+ line script

## Suggested Implementation Order

### Phase 1: trust and correctness

1. Workstream 1
2. Workstream 3
3. Workstream 4
4. Workstream 5

This phase fixes misleading UI state and stabilizes the browser/service contract.

### Phase 2: runtime model

1. Workstream 2

This is the most behaviorally meaningful change and should land after the data and UI state contract is cleaned up.

### Phase 3: maintainability

1. Workstream 6

This should happen after the new session/state model is clear, so the module boundaries reflect the right design.

## Recommended Commit Sequence

1. `ui: surface invalid persisted task state explicitly`
2. `control-plane: expose stable damaged-run summaries`
3. `ui: make validation state go stale on draft edits`
4. `control-plane: normalize api response envelopes`
5. `control-plane: launch runs as background sessions`
6. `ui: split control-plane browser app by responsibility`
7. `tests/docs: cover phase 4 mid-patch behavior`

## Verification Commands

Run these after each completed workstream where relevant:

```powershell
npm.cmd test
```

Focused checks while iterating:

```powershell
node tests/control-plane.test.js
node tests/ui-server.test.js
node tests/collaboration-store.test.js
```

Manual behavior checks:

1. Start with an invalid `shared/task.json` and confirm the UI blocks unsafe overwrite paths.
2. Launch a long-running task and confirm the Runs dashboard shows live state before completion.
3. Simulate a damaged run directory and confirm the run remains visible as damaged.
4. Validate a config, edit one field, and confirm the validation banner becomes stale immediately.

## Docs To Update After Code Changes

If behavior changes materially, update:

- `README.md`
- `docs/cli.md`
- `docs/config.md`
- `docs/ui.md`
- `shared/task.example.json` if any saved config examples need clarification

Focus on:

- what the UI does when persisted config is invalid
- how live runs now appear in the dashboard
- what users should expect when old run data is damaged

## Non-Goals

This patch does not:

- add authentication or remote multi-user control-plane support
- introduce WebSockets or server-sent events
- replace the dependency-free UI with a framework
- redesign the visual look of the UI
- add deep artifact search or filtering beyond the current dashboard scope

## Definition Of Done

This patch is complete when:

- invalid persisted config is surfaced explicitly and never silently replaced
- `Run Now` launches a background run session rather than blocking until completion
- damaged or missing run data produces visible, recoverable UI states
- validation status is always tied to the current draft, not a previous version
- every UI JSON endpoint uses one response envelope
- the browser app is split enough that future fixes land in focused modules
- the relevant tests are green

## Closeout

### Implemented outcomes

- invalid persisted `shared/task.json` files are surfaced explicitly, including raw file contents
- save, validate, and run actions are blocked against invalid persisted task state until the user explicitly starts a new draft
- run launch now creates background run sessions and the Runs dashboard polls live session state
- damaged or missing run records are represented as visible recoverable UI states instead of being dropped or crashing detail rendering
- validation status is tied to the current draft version and becomes stale immediately after edits
- the control-plane API uses a consistent `{ ok, data }` / `{ ok: false, error }` envelope
- the browser app is split by responsibility instead of living in one large script

### Current browser module layout

- `apps/ui/public/ui-core.js`
  Shared UI helpers
- `apps/ui/public/ui-render.js`
  Screen rendering
- `apps/ui/public/ui-state.js`
  Draft/config state transitions and derived UI state
- `apps/ui/public/ui-actions.js`
  Control-plane calls and run-session polling
- `apps/ui/public/ui-bindings.js`
  DOM event wiring
- `apps/ui/public/app.js`
  Composition and bootstrap

### Verification snapshot

- `node tests/ui-app.test.js`
- `node tests/ui-server.test.js`
- `npm.cmd test`
