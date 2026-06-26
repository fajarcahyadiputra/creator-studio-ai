# Feature Alignment With Master Prompt

This document compares the master prompt expectations with the current repository state.

## Summary

The repository is broadly aligned with the master prompt as a Phase 1 foundation. Most major gaps are intentional Phase 2+ roadmap items, not accidental omissions.

One concrete foundation gap was corrected during this review:

- Job retry commands now require `Idempotency-Key`.
- Retry attempts now persist idempotency metadata at the attempt level.
- Retry workflow start now records a structured failure when Temporal startup fails.

## Already Aligned In Phase 1

- Modular Node.js monolith plus separate Python worker boundary.
- No FFmpeg or AI inference in Node.js.
- MinIO/S3 object-storage media exchange.
- Multipart browser upload with presigned URLs.
- Temporal-based durable workflow envelope.
- SSE job event streaming with polling fallback.
- Auth, RBAC, impersonation, CSRF, rate limiting, and secure sessions.
- Prisma schema covering the forward-looking domain model.
- Docker Compose development stack and Kubernetes baseline.
- AI maintenance and architecture documentation.

## Intentionally Deferred To Phase 2+

These are present in the prompt but are not yet implemented in code because the repository is still a Phase 1 foundation:

- External source ingestion that downloads approved media into MinIO.
- FFprobe validation after upload.
- faster-whisper transcription pipeline.
- Scene and silence detection.
- LLM clip-candidate analyzer.
- Reframing, subtitle rendering, and final clip rendering.
- Clip preview/download pipeline.
- TTS execution pipeline.
- Transcript editor and subtitle export workflow.
- Publishing integrations.
- Billing/quota settlement behavior.
- Advanced admin CRUD surfaces for providers, models, plans, and system settings.

## Remaining Known Gaps Inside Phase 1

These items still appear in the prompt or product docs but are not fully implemented in the current codebase:

- Audit logging for job cancel/retry actions is not yet consistently wired through the job service.
- Stage-weighted overall progress is not yet implemented; current projection stores the reported overall progress directly.
- Full session-management UI, media-library UI, and broader admin CRUD pages remain ahead of the current shipped surface.
- ZIP packaging/export workflows mentioned in the prompt are not implemented.

## Guidance

- Treat the Phase 2+ items as roadmap work, not regressions.
- Treat the remaining Phase 1 gaps as candidates for the next implementation passes.
- When evaluating prompt compliance, compare against `docs/roadmap.md` and `docs/product-blueprint.md` so the intended phase boundary stays explicit.
