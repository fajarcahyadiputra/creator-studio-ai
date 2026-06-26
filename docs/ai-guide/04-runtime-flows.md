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

Key file:

- `apps/web-node/src/modules/uploads/upload-service.ts`

## Auto-Clipping Job

1. Browser submits `/api/v1/auto-clipping/jobs` with `Idempotency-Key`.
2. `JobService.createAutoClippingJob` validates source ownership if a media asset is used.
3. Node creates `Job`, first `JobAttempt`, and `AutoClipRequest` in Postgres.
4. Node starts Temporal workflow `FoundationAutoClippingWorkflow`.
5. Python workflow validates the envelope.
6. Python emits progress through Node internal API.
7. `JobProjectionService` writes authoritative `JobEvent`, updates `Job`/`JobStage`, and publishes a Redis notification.
8. Browser receives events through `/api/v1/jobs/:jobId/events/stream`.
9. Polling fallback is available at `/api/v1/jobs/:jobId/events`.
10. Phase 1 workflow ends as `NEEDS_REVIEW`.

Key files:

- `apps/web-node/src/modules/jobs/job-service.ts`
- `apps/web-node/src/modules/jobs/job-projection-service.ts`
- `apps/web-node/src/modules/jobs/routes.ts`
- `apps/web-node/src/modules/internal/routes.ts`
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
