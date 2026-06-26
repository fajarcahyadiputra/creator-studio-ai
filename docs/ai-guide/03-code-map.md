# Code Map

Use this as the starting point when deciding where to make a change.

## Web Node App

Main entry:

- `apps/web-node/src/server.ts`
- `apps/web-node/src/app.ts`

Modules:

- `apps/web-node/src/modules/auth`: registration, login, logout, password reset, email verification, Google OAuth wiring, CSRF/session identity.
- `apps/web-node/src/modules/admin`: audit-safe impersonation routes.
- `apps/web-node/src/modules/uploads`: multipart upload session creation, completion, abort, and presigned S3/MinIO part URLs.
- `apps/web-node/src/modules/jobs`: job creation, listing, detail, cancel, retry, duplicate, event polling, SSE stream, and state machine tests.
- `apps/web-node/src/modules/internal`: service-authenticated progress ingestion from Python activities.
- `apps/web-node/src/modules/audit`: audit writes.
- `apps/web-node/src/modules/health`: health and metrics endpoints.
- `apps/web-node/src/modules/dashboard`: EJS page routes.

Infrastructure:

- `apps/web-node/src/infrastructure/database/prisma.ts`: Prisma client.
- `apps/web-node/src/infrastructure/storage/s3.ts`: S3/MinIO clients.
- `apps/web-node/src/infrastructure/redis/client.ts`: Redis client.
- `apps/web-node/src/infrastructure/session/session.ts`: Redis-backed Express sessions.
- `apps/web-node/src/infrastructure/temporal/client.ts`: Temporal client.
- `apps/web-node/src/infrastructure/queue/*`: BullMQ email queue foundation.

Shared helpers:

- `apps/web-node/src/shared/errors/app-error.ts`
- `apps/web-node/src/shared/http/*`
- `apps/web-node/src/shared/logging/logger.ts`

UI:

- `apps/web-node/src/views`: EJS views.
- `apps/web-node/src/public/css/app.css`
- `apps/web-node/src/public/js/app.js`

## Python Media App

Main files:

- `apps/ai-media-python/app/worker.py`: registers Temporal worker.
- `apps/ai-media-python/app/api/main.py`: FastAPI health API.
- `apps/ai-media-python/app/workflows/foundation_auto_clipping.py`: Phase 1 workflow envelope.
- `apps/ai-media-python/app/activities/progress.py`: validation and progress callback activities.
- `apps/ai-media-python/app/infrastructure/callback_client.py`: calls Node internal progress endpoint.
- `apps/ai-media-python/app/domain/contracts.py`: Pydantic event/input contracts.
- `apps/ai-media-python/app/application/foundation_validation.py`: workflow input validation.
- `apps/ai-media-python/app/media/ffmpeg.py`: media boundary placeholder/helper area.
- `apps/ai-media-python/app/providers/base.py`: provider adapter foundation.

Tests:

- `apps/ai-media-python/tests/test_clip_scoring.py`
- `apps/ai-media-python/tests/test_ffmpeg.py`
- `apps/ai-media-python/tests/test_foundation_validation.py`

## Media Ingestion App

Main files:

- `apps/media-ingestion-node/src/server.ts`
- `apps/media-ingestion-node/src/security/source-url.ts`
- `apps/media-ingestion-node/src/security/ip.ts`
- `apps/media-ingestion-node/src/service-auth.ts`

Current responsibility: validate allowed external source URLs with SSRF-aware checks. It does not download media yet.

## Contracts

- `packages/contracts/src/index.ts`: shared TypeScript contract types such as job status, progress event, workflow input, and error envelope.
- `packages/contracts/json-schema/clip-analyzer.schema.json`: structured analyzer schema.

## Database

Prisma schema:

- `apps/web-node/prisma/schema.prisma`

Baseline migration:

- `apps/web-node/prisma/migrations/202606260001_init/migration.sql`

Seed:

- `apps/web-node/prisma/seed.ts`

Major model groups:

- Identity and access: `User`, `Role`, `Permission`, `UserRole`, `Session`, OAuth and auth tokens.
- AI configuration: `AiProvider`, `AiModel`, `AiModelCapability`, `EncryptedCredential`, `UserAiPreference`.
- Media and uploads: `Project`, `MediaAsset`, `UploadSession`.
- Jobs and workflow projection: `Job`, `JobStage`, `JobEvent`, `JobAttempt`, `JobError`.
- Product outputs: `AutoClipRequest`, `ClipCandidate`, `ClipOutput`, `Transcript`, `SubtitleAsset`, `TtsRequest`, `TtsOutput`, publishing models.
- Commercial/audit: `Plan`, `Quota`, `UsageRecord`, `Notification`, `WebhookEndpoint`, `AuditLog`, feature/system settings.

## First Files By Change Type

Workflow/job changes:

1. `apps/web-node/src/modules/jobs/job-service.ts`
2. `apps/web-node/src/modules/jobs/job-projection-service.ts`
3. `apps/web-node/src/modules/jobs/routes.ts`
4. `apps/ai-media-python/app/workflows/foundation_auto_clipping.py`
5. `apps/ai-media-python/app/activities/progress.py`

Upload/media changes:

1. `apps/web-node/src/modules/uploads/upload-service.ts`
2. `apps/web-node/src/infrastructure/storage/s3.ts`
3. `apps/media-ingestion-node/src/security/source-url.ts`
4. `apps/ai-media-python/app/media/ffmpeg.py`

Database changes:

1. `apps/web-node/prisma/schema.prisma`
2. `apps/web-node/prisma/seed.ts`
3. `infra/scripts/validate-migration.mjs`
