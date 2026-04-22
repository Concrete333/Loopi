# Context Guide

You can attach a context folder to a task with top-level `context.dir`:

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

## Folder Conventions

- `shared/`: reused in every phase when budget allows
- `plan/`: planning-specific material
- `implement/`: implementation-specific material
- `review/`: review-specific material
- `examples/`: reusable examples
- `schema/`: treated like implement-phase context
- `rubric/`: treated like review-phase context

`maxFilesPerPhase` limits how many files are selected for a phase. `maxCharsPerPhase` limits the total text budget before provider-specific limits are applied.

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

## Key Notes

- `reviewSynthesis` governs plan-mode synthesis, review-mode synthesis, and one-shot review synthesis.
- `deliveryPolicy.default` is a starting value, not a lock.
- `reviewParallel` still defaults to `full`. If review-mode token usage is your main cost driver, `reviewParallel: "digest"` is the highest-signal override to try first.
- The digest is built mechanically from the selected files, so it stays compact without a second summarization pass.
- `maxInputChars` on a provider limits the rendered digest section, not the entire final prompt.
- Runtime `[context]` log lines report actual emitted context chars and note later-cycle downgrades such as `(cycle 2 downgrade from full)`.
- Set `LOOPI_SILENT=1` to suppress those log lines in CI or scripted runs.
- Set a stage to `none` to omit context entirely for that step.

## Tuning Workflow

1. Measure a baseline with `npm run measure:context`.
2. If review-mode cost is the main issue, try `reviewParallel: "digest"` first.
3. For broader savings, try `deliveryPolicy.default: "digest"` and then restore specific stages such as `implementInitial` or `reviewInitial` to `full`.
4. Use `none` only for stages that are safe without direct context.

If you want more control, set `context.manifest` to a JSON manifest file. Manifest entries can annotate files with `phase`, `priority`, or `purpose`, and those annotations are merged into the context index during selection.
