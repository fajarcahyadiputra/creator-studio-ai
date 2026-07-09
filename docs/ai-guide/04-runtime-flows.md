# Runtime Flows

This file summarizes the important runtime paths.

## Browser Upload

1. Browser calls the web upload API.
2. `UploadService` validates file name, MIME/extension match, size, and project ownership.
3. Node creates a `MediaAsset` and `UploadSession`.
4. Node creates a multipart upload in MinIO/S3.
5. Node returns presigned URLs for each part.
6. Browser uploads file parts directly to MinIO/S3.
7. Browser calls complete upload.
8. Node completes multipart upload and marks the asset `VALIDATING`.
9. Node starts `MediaAssetValidationWorkflow` through Temporal and updates `MediaAsset.metadata.validation.status` to `QUEUED` when that succeeds.
10. If the workflow trigger fails, Node keeps the asset in `VALIDATING` and records `TRIGGER_FAILED` metadata instead of pretending that validation completed.
11. A Python media-validation slice can inspect the stored object and report FFprobe-style metadata back to Node through `/internal/v1/media-assets/:mediaAssetId/validation-result`.
12. Node marks the asset `READY` or `FAILED` and stores the normalized metadata on the `MediaAsset` row.
13. The validation-context endpoint now returns a short-lived internal signed read URL so a Python probe activity can inspect the object without direct database or bucket credentials.
14. The Python media-validation slice can now run an FFprobe command against that signed URL and turn probe results into a `READY` or `FAILED` validation payload.
15. Once a media asset is `READY`, the Python audio-extraction planning slice can build a stable FFmpeg command and working-path contract for the later transcription stage.
16. The Python audio-extraction execution slice can now run that FFmpeg command and require the output audio artifact to exist before the stage is considered successful.

While the full worker-triggered validation pipeline is still being wired, `MediaAsset.metadata.validation` now records an explicit pending-worker state immediately after upload completion so operators can distinguish "awaiting validation orchestration" from an ordinary `READY` asset.

Key file:

- `apps/web-node/src/modules/uploads/upload-service.ts`
- `apps/web-node/src/modules/internal/routes.ts`
- `apps/ai-media-python/app/media/ffmpeg.py`

## Auto-Clipping Job

1. Browser submits `/api/v1/auto-clipping/jobs` with `Idempotency-Key`.
2. `JobService.createAutoClippingJob` validates source ownership if a media asset is used.
3. Node creates `Job`, first `JobAttempt`, and `AutoClipRequest` in Postgres.
4. Node starts Temporal workflow `FoundationAutoClippingWorkflow`.
5. Python workflow validates the envelope.
6. Python emits progress through Node internal API.
7. Progress emission is best-effort observability. If the internal callback rejects or is temporarily unavailable, Python now logs the callback failure and continues the core workflow instead of failing the entire job purely because projection sync failed.
8. If `analysis_inputs` is already present, Python uses that structured transcript/scene/silence payload directly.
9. If `analysis_inputs` is absent but `source.media_asset_id` is present, Python now fetches the validated media asset context, extracts mono WAV audio, runs transcription, persists the normalized transcript back to Node, and converts that transcript into minimal `analysis_inputs`.
10. Candidate analysis runs against the prepared transcript-driven inputs and produces ranked clip candidates plus metadata suggestions.
11. `JobProjectionService` writes authoritative `JobEvent`, updates `Job`/`JobStage`, and publishes a Redis notification.
12. Browser receives events through `/api/v1/jobs/:jobId/events/stream`.
13. Polling fallback is available at `/api/v1/jobs/:jobId/events`.
14. When the user selects a candidate, Node can immediately create `ClipOutput` rows and auto-start one `ClipOutputRenderWorkflow` per newly created output without a separate manual queue step.
15. The Python render slice now executes FFmpeg-based clip rendering from the source media window, extracts a thumbnail, validates the final output with FFprobe, and can skip a separate preview MP4 when storage optimization is preferred.
16. Subtitle generation now persists timed sidecars for `SRT`, `ASS`, `VTT`, and `JSON`, while the selected subtitle format can also be burned into the final render when requested by the render settings.
17. Node receives final/metadata/thumbnail/subtitle artifact results through the internal clip-output result endpoint and persists official `MediaAsset` plus `SubtitleAsset` rows for every supplied sidecar format.
18. The job detail experience and public jobs API now expose validation summaries, render warnings, grouped pipeline phases, strategy snapshots, and per-format artifact download/export links for downstream review.

Key files:

- `apps/web-node/src/modules/jobs/job-service.ts`
- `apps/web-node/src/modules/jobs/job-projection-service.ts`
- `apps/web-node/src/modules/jobs/routes.ts`
- `apps/web-node/src/modules/internal/routes.ts`
- `apps/ai-media-python/app/activities/audio_pipeline.py`
- `apps/ai-media-python/app/activities/render_outputs.py`
- `apps/ai-media-python/app/activities/transcription_pipeline.py`
- `apps/ai-media-python/app/workflows/clip_output_render.py`
- `apps/ai-media-python/app/workflows/foundation_auto_clipping.py`
- `apps/ai-media-python/app/activities/progress.py`

## Progress Projection

Python activities call:

```text
POST /internal/v1/jobs/:jobId/events
```

Node then:

1. Validates service authentication.
2. Validates the event payload with Zod.
3. Increments `Job.eventSequence`.
4. Writes `JobEvent`.
5. Updates `Job` status, stage, progress, and completion timestamp where appropriate.
6. Upserts `JobStage`.
7. Publishes a lightweight Redis notification.
8. SSE subscribers fetch authoritative events from PostgreSQL.

Redis is only fan-out. PostgreSQL is authoritative.

## Retry

- Retry only applies to `FAILED` jobs.
- Manual retry creates a new `JobAttempt`.
- Manual retry starts a new workflow ID.
- Automatic activity retries stay inside the same workflow run.
- Duplicate creates a new job from the previous input snapshot.

Key file:

- `apps/web-node/src/modules/jobs/job-service.ts`

## Cancel

1. Node verifies job ownership and cancelable status.
2. Node sets status to `CANCEL_REQUESTED`.
3. Node asks Temporal to cancel the workflow.
4. Python activities must heartbeat and allow cancellation to propagate.
5. The internal projection should mark `CANCELED` only after workflow confirmation.

## Public API Pointers

Main public API paths:

- Auth: `/api/v1/auth/*`
- Uploads: `/api/v1/uploads/*`
- Auto clipping: `/api/v1/auto-clipping/jobs`
- Jobs: `/api/v1/jobs`, `/api/v1/jobs/:jobId`, cancel/retry/events/SSE

Internal API:

- Progress: `/internal/v1/jobs/:jobId/events`
- Internal health: `/internal/v1/health`
