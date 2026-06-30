# Create Video Integration Plan

## 1. Existing Project Analysis

The repository is already structured as a durable creator workspace, not a blank starter:

- `apps/web-node` is the authenticated browser app and API layer built with Express, EJS, Prisma, Redis-backed sessions, SSE, and Temporal orchestration.
- `apps/ai-media-python` is the media and AI worker runtime registered against Temporal.
- `apps/media-ingestion-node` is a focused ingestion/security boundary for external media sources.
- PostgreSQL is the source of truth for product entities and job projections.
- MinIO/S3 stores media bytes; the database stores object keys and metadata.
- Redis is used for session state, rate limiting, and lightweight realtime fan-out.
- Temporal already owns durable workflow orchestration and retries for long-running media work.

Relevant existing patterns we should preserve:

- User-facing pages live in `apps/web-node/src/views`.
- Page routes are grouped by module, for example `dashboard`, `media`, `presets`, `settings`, and `jobs`.
- Background progress is projected through `Job`, `JobStage`, `JobEvent`, `JobAttempt`, and SSE at `/api/v1/jobs/:jobId/events/stream`.
- Uploads already use `UploadService` plus signed multipart URLs and `MediaAsset` metadata rows.
- Python workers already report back to Node through service-authenticated internal endpoints.

## 2. Technology Inventory

Web platform:

- Node.js + Express
- EJS server-rendered UI
- Prisma + PostgreSQL
- Redis sessions and event fan-out
- Temporal client
- MinIO/S3 object storage
- Pino logging

Worker platform:

- Python
- Temporal worker
- Pydantic contracts
- FFmpeg/FFprobe helper boundary
- HTTP callback/internal client pattern back to Node

## 3. Reusable Modules

These modules can be reused directly for Create Video:

- `modules/uploads` for signed upload URLs and asset intake
- `modules/jobs` for durable orchestration, retry, cancel, event history, and SSE
- `modules/media` for user-owned media listing and metadata handling
- `modules/settings` and `modules/presets` for user defaults and style presets
- `modules/internal` for Python-to-Node progress/result callbacks
- `JobProjectionService` for authoritative progress calculation and stage persistence

These worker concepts can also be reused:

- validation activity structure
- transcription pipeline structure
- render-output workflow structure
- callback and progress emission pattern

## 4. Recommended Domain Shape

To stay aligned with the current architecture, Create Video should **reuse existing shared tables** where possible and add only feature-specific aggregates.

Reuse existing shared tables:

- `Project` for workspace/project ownership
- `MediaAsset` for uploaded images, uploaded narrator audio, generated audio, background music, thumbnails, subtitles, and final videos
- `UploadSession` for multipart uploads
- `Job`, `JobStage`, `JobEvent`, `JobAttempt`, `JobError` for orchestration and progress
- `UsageRecord` and `Quota` for quota reservation and consumption

Add feature-specific tables:

- `CreateVideoProject`
- `CreateVideoScene`
- `CreateVideoAssetLink`
- `CreateVideoOutput`

Recommended job type addition:

- extend `JobType` with `CREATE_VIDEO`

This is safer than introducing a second parallel job system such as `video_jobs`, because the repository already has a mature durable job projection model.

## 5. Recommended Database Changes

### New `CreateVideoProject`

Purpose:

- feature-specific configuration and authoring state

Suggested fields:

- `id`
- `userId`
- `projectId`
- `title`
- `script`
- `audioMode` (`UPLOADED`, `TTS`, `NONE`)
- `aspectRatio`
- `resolution`
- `fps`
- `videoStyle`
- `subtitleStyle`
- `transitionStyle`
- `outputQuality`
- `status`
- `metadata`
- `createdAt`
- `updatedAt`
- `deletedAt`

### New `CreateVideoAssetLink`

Purpose:

- ordered attachment of existing `MediaAsset` rows into a create-video project

Suggested fields:

- `id`
- `createVideoProjectId`
- `mediaAssetId`
- `assetRole` (`IMAGE`, `NARRATION_AUDIO`, `BACKGROUND_MUSIC`, `OUTPUT_VIDEO`, `OUTPUT_THUMBNAIL`, `OUTPUT_SUBTITLE`, `GENERATED_AUDIO`)
- `sortOrder`
- `metadata`
- `createdAt`

### New `CreateVideoScene`

Purpose:

- persisted script segmentation, selected image, timing, and motion plan

Suggested fields:

- `id`
- `createVideoProjectId`
- `sceneOrder`
- `narrationText`
- `startMs`
- `endMs`
- `visualQuery`
- `selectedAssetLinkId`
- `motion`
- `transition`
- `metadata`
- `createdAt`
- `updatedAt`

### New `CreateVideoOutput`

Purpose:

- final and preview outputs linked back to the shared `MediaAsset` table

Suggested fields:

- `id`
- `createVideoProjectId`
- `jobId`
- `mediaAssetId`
- `outputType` (`PREVIEW`, `FINAL`, `THUMBNAIL`, `SUBTITLE`, `TIMELINE_JSON`, `RENDER_METADATA`)
- `durationMs`
- `width`
- `height`
- `qualityStatus`
- `metadata`
- `createdAt`

## 6. Integration Points

### Web Node

- add a new user module, likely `modules/create-video`
- register its router in `apps/web-node/src/app.ts`
- add navigation entry in `views/partials/sidebar.ejs`
- reuse existing CSRF, session, auth, rate limit, error handling, and audit patterns

### Uploads

- use existing upload session flow for images, narrator audio, and background music
- attach created `MediaAsset` rows to `CreateVideoProject` through `CreateVideoAssetLink`

### Jobs and Progress

- create `Job` rows with `type = CREATE_VIDEO`
- create a feature-specific request snapshot in `Job.inputSnapshot`
- persist stage progress through the same `JobProjectionService`
- expose progress to the browser through the same SSE stream already used for auto clipping

### Python Worker

- add a new Temporal workflow such as `CreateVideoWorkflow`
- break processing into activities:
  - validate assets
  - analyze images
  - prepare audio
  - transcribe or align
  - analyze script
  - match images
  - build timeline
  - generate subtitles
  - render video
  - validate output
  - submit output result

### Storage

- continue using private MinIO/S3 object storage
- store only object keys and metadata in PostgreSQL
- signed upload and download URLs remain the only browser storage access pattern

## 7. File Additions

Likely new web files:

- `apps/web-node/src/modules/create-video/routes.ts`
- `apps/web-node/src/modules/create-video/service.ts`
- `apps/web-node/src/modules/create-video/schemas.ts`
- `apps/web-node/src/modules/create-video/routes.test.ts`
- `apps/web-node/src/views/app/create-video-projects.ejs`
- `apps/web-node/src/views/app/create-video-new.ejs`
- `apps/web-node/src/views/app/create-video-detail.ejs`

Likely Prisma changes:

- `apps/web-node/prisma/schema.prisma`
- new migration directory under `apps/web-node/prisma/migrations/...`

Likely worker files:

- `apps/ai-media-python/app/workflows/create_video.py`
- `apps/ai-media-python/app/activities/create_video_assets.py`
- `apps/ai-media-python/app/activities/create_video_audio.py`
- `apps/ai-media-python/app/activities/create_video_script_analysis.py`
- `apps/ai-media-python/app/activities/create_video_scene_matching.py`
- `apps/ai-media-python/app/activities/create_video_timeline.py`
- `apps/ai-media-python/app/activities/create_video_render.py`
- `apps/ai-media-python/app/infrastructure/create_video_client.py`
- corresponding tests

Documentation:

- `docs/create-video-integration-plan.md`
- later `docs/create-video-feature.md`

## 8. Existing Files That Will Change

Web:

- `apps/web-node/src/app.ts`
- `apps/web-node/src/views/partials/sidebar.ejs`
- `apps/web-node/src/config/env.ts`
- `apps/web-node/src/modules/uploads/upload-service.ts`
- `apps/web-node/src/modules/jobs/job-service.ts`
- `apps/web-node/src/modules/jobs/routes.ts`
- `apps/web-node/src/modules/internal/routes.ts`
- `apps/web-node/src/public/js/app.js`
- `apps/web-node/src/public/css/app.css`

Database:

- `apps/web-node/prisma/schema.prisma`
- `apps/web-node/prisma/seed.ts` if permissions or feature flags are added

Worker:

- `apps/ai-media-python/app/worker.py`
- `apps/ai-media-python/app/domain/contracts.py`
- possibly `apps/ai-media-python/app/config.py`

## 9. Risk Assessment

Main risks:

- `JobType` expansion can affect existing enum handling and tests.
- Upload validation for images/audio/music must not weaken current media security checks.
- Reusing `MediaAsset` for many Create Video roles requires clear metadata conventions to avoid ambiguous asset ownership and purpose.
- Long render jobs can increase Temporal queue depth and storage usage if stage caching is not designed carefully.
- New route/module wiring must not break the current sidebar, auth flow, or CSRF assumptions.
- If scene/timeline data is stored only in `Job.inputSnapshot`, editability and rerender support will become brittle.

Mitigations:

- add Create Video behind a feature flag or limited navigation slice first
- keep the existing job projection model instead of inventing another background-job system
- use dedicated feature tables for authored state and shared tables for cross-cutting concerns
- preserve idempotency keys and retry semantics already used by `JobService`

## 10. Safe Migration Plan

1. Add the new Prisma models and `JobType.CREATE_VIDEO`.
2. Add migration only; do not rewrite baseline migration.
3. Keep new tables nullable only where needed for a safe rollout.
4. Ship read/write code only after migration exists.
5. Introduce routes and pages behind a navigation entry once schema is available.
6. Start with manual image/audio upload plus project creation.
7. After project creation is stable, add Create Video job creation and SSE progress.
8. After orchestration is stable, add worker activities and output persistence.

## 11. Implementation Phases

### Phase A: Foundation

- add schema
- add module scaffolding
- add sidebar entry
- add list/create/detail pages
- add project CRUD

### Phase B: Asset Intake

- attach uploaded images, narrator audio, and music to create-video projects
- validate ownership and file types
- persist ordering metadata

### Phase C: Background Job Orchestration

- add `CREATE_VIDEO` job creation
- add workflow start in Node
- add job progress stages and SSE rendering

### Phase D: Worker MVP

- asset validation
- image analysis
- uploaded-audio preparation
- transcription/alignment
- script scene analysis
- scene matching
- timeline build
- subtitle generation
- FFmpeg render
- output validation

### Phase E: Review and Rerender

- preview/download output
- rerender from cached scene/timeline data
- retry/cancel support

## 12. First Practical Slice To Implement

The safest first slice is:

1. Add the database schema for Create Video projects/scenes/outputs.
2. Add the user navigation entry.
3. Add Create Video project CRUD pages and routes.
4. Reuse existing upload flow to attach images/audio/music.
5. Add a `CREATE_VIDEO` job launcher that stores a valid request snapshot but can initially stop before full rendering if the worker slice is not ready.

That slice gives us a real product surface without forcing a rushed full render pipeline in one step.
