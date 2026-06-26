# Workflows

## Auto clipping target workflow

```mermaid
flowchart TD
  A[VALIDATING_SOURCE] --> B{External source?}
  B -->|Yes| C[INGESTING_SOURCE]
  B -->|No| D[PROBING_MEDIA]
  C --> D
  D --> E[EXTRACTING_AUDIO]
  E --> F[TRANSCRIBING]
  F --> G[DIARIZING_OR_SPEAKER_ANALYSIS]
  F --> H[DETECTING_SCENES]
  F --> I[DETECTING_SILENCE]
  G --> J[ANALYZING_CLIP_CANDIDATES]
  H --> J
  I --> J
  J --> K[NORMALIZING_BOUNDARIES]
  K --> L[RANKING_AND_DEDUPLICATING]
  L --> M[GENERATING_PREVIEWS]
  M --> N[REFRAMING]
  N --> O[GENERATING_SUBTITLES]
  O --> P[RENDERING_FINAL_CLIPS]
  P --> Q[QUALITY_CHECK]
  Q -->|Pass| R[GENERATING_METADATA]
  Q -->|Warning| S[NEEDS_REVIEW]
  R --> T[UPLOADING_OUTPUTS]
  T --> U[COMPLETED]
```

## Phase 1 workflow

The included Python worker proves cross-language orchestration and progress projection. It validates the request envelope, emits progress, creates durable history, supports cancellation, and deliberately ends an auto-clipping job as `NEEDS_REVIEW` with a message that Phase 2 media activities are not enabled. It never fabricates clip output.

## Activity requirements

Every media activity added in Phase 2 must define:

- start-to-close timeout;
- heartbeat timeout for long-running operations;
- retry policy and non-retryable error types;
- activity idempotency key;
- cancellation checks;
- structured progress events;
- checkpoint object key;
- temporary-file cleanup;
- versioned output object key.

## Retry semantics

- Automatic activity retries stay inside the same workflow run.
- Manual retry creates a `JobAttempt` and starts a new workflow ID for the same job.
- Completed outputs are immutable and versioned.
- Duplicate creates a new job and copies the prior input snapshot.

## Cancellation

Node requests Temporal cancellation and records `CANCEL_REQUESTED`. Python activities must heartbeat and allow cancellation to propagate. The internal projection marks the job `CANCELED` only after the workflow confirms cancellation.
