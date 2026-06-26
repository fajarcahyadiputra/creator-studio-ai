# Roadmap

## Phase 1 — Foundation

Implemented in this ZIP: monorepo, auth/RBAC, user/admin layouts, Prisma/PostgreSQL, Redis/BullMQ, MinIO multipart upload, durable job framework, Temporal connection, SSE, audit logs, basic observability, Docker Compose, and Kubernetes baseline.

## Phase 2 — Auto Clipping MVP

- Source ingestion and post-upload media validation.
- FFprobe and audio extraction.
- faster-whisper segments and word timestamps.
- Scene/silence analysis.
- Structured LLM clip-candidate analyzer.
- Boundary normalization and deduplication.
- Center/face crop, subtitle generation, rendering, and quality checks.
- Preview, download, retry, cancellation, and progress.

## Phase 3 — Advanced Clipping

Active-speaker tracking, split screen, better reframing, lightweight editor, brand presets, advanced quality scoring, and per-clip regeneration.

## Phase 4 — TTS and Transcription

Provider abstraction, duration assistance, transcript editor, speaker rename, subtitle export, translation, and burn-in.

## Phase 5 — Publishing, Billing, and Scale

Official social OAuth/publishing, quota settlement, payments, Kubernetes autoscaling, provider routing/fallback policy, and cost dashboards.
