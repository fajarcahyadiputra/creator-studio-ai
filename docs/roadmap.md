# Roadmap

## Phase 1 - Foundation

Implemented in this repository: monorepo, auth/RBAC, user/admin layouts, Prisma/PostgreSQL, Redis/BullMQ, MinIO multipart upload, durable job framework, Temporal connection, SSE, audit logs, observability baseline, Docker Compose, and Kubernetes baseline.

## Phase 2 - Auto Clipping MVP

Implemented or largely in place:

- Source ingestion and post-upload media validation.
- FFprobe and audio extraction.
- faster-whisper transcript segments and word timing persistence.
- Scene/silence enrichment plus boundary normalization and deduplication.
- Structured OpenAI clip-candidate analyzer with Python heuristic fallback/runtime switching.
- Final render execution, subtitle sidecars, subtitle burn-in, validation summaries, and export indexes.
- Job playback, download, retry, regenerate, duplicate, delete, and progress tracking.

Remaining polish:

- Additional layout/template tuning for 9:16 outputs and subtitle presentation.
- Broader regression coverage for regenerate/retry and long-form imports.
- End-to-end validation across Node, Python, and object-storage pipelines.

## Phase 3 - Advanced Clipping

Active-speaker tracking, split-screen layouts, better reframing, lightweight editor flows, brand presets, advanced quality scoring, and deeper per-clip iteration controls.

## Phase 4 - TTS and Transcription

Provider abstraction, duration assistance, transcript editor, speaker rename, subtitle export, translation, burn-in, and richer TTS runtime controls.

## Phase 5 - Publishing, Billing, and Scale

Official social OAuth/publishing, quota settlement, payments, Kubernetes autoscaling, provider routing/fallback policy, and cost dashboards.
