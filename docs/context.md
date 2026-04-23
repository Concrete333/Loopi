# Context Guide

This guide is for new users who want Loopi to work from real reference material instead of just the repo and the prompt.

The short version:

- your `context` folder is a curated evidence pack for the workflow
- you organize that material into a few simple folders
- Loopi prepares it into a generated `.loopi-context/` cache
- later runs reuse that prepared cache until the source material changes

If you treat the context folder like a dumping ground, the workflow gets noisy fast.

If you treat it like a small, intentional library for the task, Loopi gets much better.

## What The Context Folder Is For

The context folder is where you put supporting material that should shape planning, implementation, and review.

Typical examples:

- design docs
- specs
- schemas
- example code
- research notes
- review rubrics
- contracts, policies, or requirements

Think of it as "the body of evidence the agents should reason against."

It is not meant to be:

- a copy of your whole repo
- a giant personal archive
- every note you have ever written
- a replacement for good prompts

Good context is relevant, deliberate, and small enough that the selected parts stay useful.

## The Mental Model

Use this rule of thumb:

- `shared/` is what every phase may need
- `plan/` is what helps agents think
- `implement/` is what helps agents build
- `review/` is what helps agents check

Loopi does not "understand everything in the folder all at once."

Instead, it:

1. prepares the folder into normalized text chunks
2. selects a bounded subset by phase and budget
3. injects only that selected material into the relevant prompts

So the job of the context folder is not to be complete in some abstract sense.

Its job is to make the right evidence easy to select at the right stage.

## Recommended Folder Structure

Use a context root like this:

```text
context/
  shared/
  plan/
  implement/
  review/
  examples/
  rubric/
  schema/
  context.json
```

What each folder means:

- `shared/`: generally useful material across all phases
- `plan/`: framing docs, strategy notes, essay plans, architecture guidance
- `implement/`: APIs, interfaces, coding notes, technical constraints
- `review/`: acceptance criteria, QA notes, checklists, review guidance
- `examples/`: worked examples and reference patterns
- `rubric/`: grading or review criteria; treated like review context
- `schema/`: formats, interfaces, contracts; treated like implement context

Use `context.json` only when you want to override a file's:

- `phase`
- `priority`
- `purpose`

You do not need a manifest for basic use.

## What To Put In The Folder

Good candidates:

- the one design doc the feature actually depends on
- the API contract the implementation must follow
- two or three representative examples
- a review rubric or acceptance checklist
- the policy document the reviewer must enforce

Bad candidates:

- duplicated copies of repo files that are already in the working tree
- outdated drafts "just in case"
- giant folders of unrelated PDFs
- raw exports with dozens of irrelevant files
- every screenshot, asset, and binary from a project

If a file would not change how an agent plans, implements, or reviews this task, it probably does not belong here.

## Supported File Types

Loopi can prepare these file types in the current context flow:

| Extension(s) | Behavior |
| --- | --- |
| `.md`, `.txt` | read as text |
| `.json`, `.yaml`, `.yml`, `.sql`, `.csv` | read as text |
| `.js`, `.ts`, `.py`, `.html`, `.css` | read as text |
| `.ipynb` | flattened into readable text |
| `.docx` | extracted into plain text |
| `.pdf` | extracted into plain text when text is recoverable |

Unsupported or unusable files are skipped with a reason instead of silently pretending they worked.

Current non-goals:

- OCR for scanned or image-only PDFs
- PowerPoint parsing such as `.ppt` or `.pptx`
- semantic retrieval or embeddings

## How To Treat `.loopi-context/`

Loopi creates a generated cache inside your context root:

```text
context/
  .loopi-context/
    manifest.json
    normalized/
```

Treat `.loopi-context/` like build output.

- do not edit it by hand
- do not organize files inside it manually
- do not treat it as source material
- do not point prompts or docs at cache paths

If it gets deleted, Loopi can rebuild it the next time you prepare context.

If your context root lives outside the default ignored `context/` path, make sure the generated `.loopi-context/` directory is ignored in Git for that project.

For example, if you use `docs/reference-material/` as the context root, ignore `docs/reference-material/.loopi-context/` rather than assuming the default repo ignore rules will catch it.

## Basic Setup In `task.json`

Attach the folder with top-level `context.dir`:

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

You can start with just:

```json
"context": {
  "dir": "./context"
}
```

Then add tuning later if needed.

## The Normal Workflow

The intended workflow is:

1. create or update the context folder
2. prepare context
3. run Loopi
4. re-prepare only when the context inputs change

### CLI flow

Prepare once:

```powershell
npm run cli -- context prepare
```

There is also a convenience alias:

```powershell
npm run context:prepare
```

Then run normally:

```powershell
npm run cli -- run
```

### App flow

In the app, the intended flow is the same:

1. configure the context folder
2. check context status
3. click Prepare context
4. run once the cache is ready

The app should tell you whether context is:

- not configured
- missing
- config-mismatched
- stale
- ready
- ready with warnings

If you try to run while context is missing or stale, the app should block the launch before creating a live run session and point you back to the Prepare context action.

## When You Need To Prepare Again

Prepare context again when you:

- add a new source file
- remove a source file
- edit a source file in a way that changes the extracted text, size, or timestamp
- change `context.include`
- change `context.exclude`
- switch `context.manifest`
- change manifest overrides such as `phase`, `priority`, or `purpose`

Do not get in the habit of preparing on every single run if nothing changed.

The whole point of the prepared cache is reuse.

## What A Good New-User Workflow Looks Like

Here is a practical starter pattern:

1. create `context/shared/`
2. add one design doc or spec
3. create `context/implement/`
4. add one schema, API contract, or code example
5. create `context/review/`
6. add one checklist or acceptance rubric
7. prepare context
8. run Loopi

That is enough to get the benefit without overbuilding the folder.

## How Loopi Chooses What To Use

Loopi does not inject the whole folder into every prompt.

It uses folder conventions and selection budgets to choose a subset for each phase.

High-level behavior:

- exact phase matches come first
- `shared/` material is reused when budget allows
- `examples/` can be pulled in as supporting reference
- large sources are chunked
- one long source is capped so it cannot flood the prompt by itself

This means structure matters.

If you put everything in `shared/`, Loopi has less signal about what belongs where.

## Delivery Policy

`context.deliveryPolicy` accepts `full`, `digest`, or `none` for these stage keys:

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

Useful guidance:

- use `full` when direct source text matters
- use `digest` when you want lower token cost
- use `none` only when a stage can safely run without direct context

Key notes:

- `reviewSynthesis` governs plan-mode synthesis, review-mode synthesis, and one-shot review synthesis
- `deliveryPolicy.default` is a starting value, not a lock
- `reviewParallel: "digest"` is usually the highest-signal cost-saving override
- `maxInputChars` limits the rendered digest section, not the entire prompt

## Manifest Overrides

If folder placement is not enough, set `context.manifest` to a JSON manifest file.

Manifest entries can override:

- `phase`
- `priority`
- `purpose`

Use overrides sparingly.

If you find yourself overriding everything, the folder structure is probably doing too little work.

## What Preparation Actually Does

When you prepare context, Loopi:

1. scans the context root using your include/exclude rules
2. skips generated/internal paths such as `.loopi-context/`
3. normalizes supported files into plain text
4. chunks large sources into deterministic windows
5. records source metadata in `.loopi-context/manifest.json`
6. reuses unchanged prepared outputs on later prepares

The prepared cache is a reusable project artifact for this context root.

`prepareContextIndex(...)` builds or refreshes that artifact. `buildContextIndex(...)` consumes it later during runs. They are intentionally separate so Loopi can reuse prepared context across many runs instead of rebuilding it every time.

Chunked sources still show up in prompts using the original source path, not the cache path.

Example prompt labels:

```text
--- context/shared/spec.pdf [chunk 1/3] - Requirements ---
--- context/shared/spec.pdf [chunk 2/3] - Constraints ---
```

## How To Keep The Folder Healthy

Good habits:

- prefer a few strong files over many weak ones
- remove stale documents when they stop helping
- keep examples representative, not numerous
- put review criteria in `review/` or `rubric/`
- put interface details in `implement/` or `schema/`
- re-prepare after meaningful context changes

Bad habits:

- leaving old drafts beside current docs with similar names
- mixing planning, implementation, and review material in one pile
- assuming skipped files were successfully used
- committing generated cache output accidentally

## Troubleshooting

### "Prepared context cache not available"

Your prepared cache is missing or stale.

Prepare again:

```powershell
npm run cli -- context prepare
```

Or use the app's Prepare context action.

### A file is not showing up in prompts

Check:

1. is it in a supported format?
2. is it inside the context root?
3. was it excluded by your include/exclude rules?
4. was it skipped during prepare?
5. is it in the right phase folder?

### A PDF or DOCX was skipped

The extractor may have failed, the dependency may be missing, or the file may not contain usable text.

Optional dependencies for PDF and DOCX extraction:

```bash
npm install pdf-parse adm-zip
```

### Review mode is too expensive

Start by trying:

```json
"deliveryPolicy": {
  "reviewParallel": "digest"
}
```

Then measure with:

```powershell
npm run measure:context
```

## Quick Start Checklist

1. create `context/`
2. add a few relevant files in `shared/`, `implement/`, and `review/`
3. set `"context": { "dir": "./context" }` in `shared/task.json`
4. run `npm run cli -- context prepare`
5. run Loopi
6. re-prepare when the context inputs change

That is the whole shape of it.

The context folder is not there to be clever. It is there to keep the workflow grounded in the right evidence, with just enough structure that Loopi can use it well.
