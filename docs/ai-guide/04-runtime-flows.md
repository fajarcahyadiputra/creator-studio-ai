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
19. Regenerate now reuses the same job record, snapshots the latest form/runtime settings, replaces prior generated outputs for that job, and starts a fresh workflow attempt.
20. Job deletion removes the durable job records and also schedules cleanup of generated output objects so storage does not keep orphaned artifacts.
21. Candidate analysis runs under the analyzer runtime snapshot captured at job creation time, so later admin changes only affect newly created or regenerated jobs.
22. Long-running provider-backed analysis must heartbeat while waiting on OpenAI and respect `ANALYZER_TIMEOUT_SECONDS` plus `OPENAI_TIMEOUT_SECONDS` so Temporal does not cancel healthy work prematurely.

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

### Optional Speech Cleanup

The create and regenerate forms expose one `Rapikan ucapan otomatis`
checkbox. It maps to `strategy.speech_cleanup_enabled` and defaults to
`false`, so existing and new jobs do not change speech unless the user opts
in.

When enabled, the final renderer:

1. Builds a conservative edit decision list from word-level transcript
   timing.
2. Detects long silence, isolated high-confidence filler words, exact
   unintended repetition, and explicit non-speech markers.
3. Skips low-confidence edits and caps removed material at 22 percent of the
   selected clip.
4. Preserves speech-edge padding and applies short audio fades around joined
   spans.
5. Renders one cleaned intermediate timeline, then remaps transcript timing
   before subtitle generation, face tracking, crop, and final render.
6. Stores `start_time`, `end_time`, `reason`, `confidence`, and
   `final_timeline` under `quality_report.speech_cleanup`.

Semantic decisions such as off-topic discussion or an overly long intro stay
in candidate analysis. The renderer does not silently remove them because a
word-timing heuristic cannot guarantee that meaning is preserved.

Key files:

- `apps/ai-media-python/app/domain/speech_cleanup.py`
- `apps/ai-media-python/app/activities/render_outputs.py`
- `apps/ai-media-python/app/media/ffmpeg.py`
- `apps/web-node/src/views/app/auto-clipping.ejs`
- `apps/web-node/src/views/app/job-detail.ejs`

## Text-to-Speech Job

1. The user opens `/app/tools/text-to-speech`. Node reads the shared open-source voice catalog from `packages/contracts/json-schema/tts-voice-profiles.json` and merges it with Piper checkpoints actually present in `TTS_MODEL_DIR`.
2. Catalog entries are derived voice profiles. They reference a `model_key` checkpoint and configure pacing, variation, volume, and a conservative pitch transform. They are only selectable when that checkpoint is installed.
3. Raw checkpoint keys discovered in `model_tts` remain available and keep their previous synthesis behavior, so existing presets and jobs remain backward compatible.
4. `Generate test voice` calls `/api/v1/tts/local-model-preview`, which proxies to the Python API and synthesizes one short WAV directly. It does not create a `Job`, call Temporal/OpenAI, or persist an artifact.
5. Job submission validates the selected local model before creating the durable job. Unknown profile keys and profiles with missing checkpoints return a field-level `422` error.
6. Node creates `Job`, `JobAttempt`, and `TtsRequest`, then starts `FoundationTextToSpeechWorkflow`.
7. The segmentation activity uses the configured local or provider-backed segmentation mode; the local preview path is independent from this full workflow.
8. The synthesis activity resolves a profile key to its base Piper checkpoint, renders every speech segment, inserts planned pauses, applies best-effort open-source DSP tuning, and transcodes to the requested output format.
9. If optional DSP tuning fails, the original Piper WAV is retained instead of failing the TTS job.
10. Python uploads the final audio through the internal media target contract. Node persists `TtsOutput`, `MediaAsset`, duration, format, base checkpoint, selected voice profile, and renderer metadata.
11. Job detail exposes the stored audio for playback and download. No Prisma migration is required for the catalog because the selected key and render metadata are already snapshotted by `TtsRequest` and `TtsOutput`.

To add another derived voice profile, add one JSON entry to `tts-voice-profiles.json`. To add a genuinely different checkpoint, place its `.onnx` and `.onnx.json` files in `TTS_MODEL_DIR`; it will also remain selectable through its raw legacy key.

Key files:

- `packages/contracts/json-schema/tts-voice-profiles.json`
- `apps/web-node/src/modules/tts/local-tts-model-registry.ts`
- `apps/web-node/src/views/app/text-to-speech.ejs`
- `apps/web-node/src/modules/jobs/routes.ts`
- `apps/ai-media-python/app/domain/tts_models.py`
- `apps/ai-media-python/app/application/local_tts_preview.py`
- `apps/ai-media-python/app/application/local_tts_render.py`
- `apps/ai-media-python/app/application/tts_voice_profile.py`
- `apps/ai-media-python/app/activities/tts_synthesis.py`
- `apps/ai-media-python/app/workflows/foundation_text_to_speech.py`

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
- Regenerate reuses the same job and replaces generated outputs using the latest regenerate payload snapshot.

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
- Auto clipping regenerate: `/api/v1/auto-clipping/jobs/:jobId/regenerate`
- Text to speech: `/api/v1/tts/jobs`
- Text to speech regenerate: `/api/v1/tts/jobs/:jobId/regenerate`
- Lightweight local voice preview: `/api/v1/tts/local-model-preview`
- Jobs: `/api/v1/jobs`, `/api/v1/jobs/:jobId`, cancel/retry/events/SSE

Internal API:

- Progress: `/internal/v1/jobs/:jobId/events`
- Internal health: `/internal/v1/health`
