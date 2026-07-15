# Overview

This repository is a monorepo for a creator-focused media and AI platform. The current implementation includes the Phase 1 platform foundation plus a working Phase 2 auto-clipping pipeline.

## Current Project State

Implemented:

- Node.js 24 Express/EJS modular monolith.
- Email/password authentication, session handling, CSRF, rate limiting, RBAC foundations, audit-safe impersonation.
- Multipart browser upload directly to MinIO/S3 through presigned URLs.
- Job records, attempts, stages, events, cancel/retry/duplicate commands.
- Temporal workflow startup from Node.
- Python Temporal workers for media and AI stages.
- Progress callbacks from Python to Node internal API.
- PostgreSQL-backed progress projection with SSE updates.
- Media-ingestion service boundary with SSRF-aware URL validation.
- FFprobe/media validation and FFmpeg audio extraction.
- Faster-Whisper transcription with persisted normalized transcript payloads.
- Scene/silence enrichment and candidate-boundary normalization.
- OpenAI structured clip-candidate analysis with Python heuristic fallback/runtime switching.
- Final clip rendering, subtitle generation, subtitle burn-in, and clip-output persistence.
- Artifact export indexes, regenerate flows, and job detail playback/download UX.
- Forward-looking Prisma schema for media, AI providers, credentials, usage, publishing, notifications, quotas, and audit.
- Docker Compose development stack and monitoring baseline.

Not implemented yet:

- Official publishing flow.
- Billing/quota settlement business behavior.
- Full social publishing/OAuth lifecycle.
- Comprehensive end-to-end regression coverage for every long-running worker path.

## Repository Map

```text
apps/web-node/                 Express + EJS modular monolith
apps/media-ingestion-node/     SSRF-aware external source validation boundary
apps/ai-media-python/          FastAPI health API and Temporal Python worker foundation
packages/contracts/            Shared Node/Python-facing contract types and JSON schemas
infra/                         Kubernetes, monitoring, and migration validation scripts
docs/                          Architecture, workflow, security, operations, API docs
docs/ai-guide/                 Focused AI-agent onboarding notes
```

Important root files:

- `AGENTS.md`: mandatory engineering and architecture rules.
- `README.md`: quick start and technology baseline.
- `VALIDATION.md`: last known validation report and known untested areas.
- `docker-compose.yml`: local development stack.
- `Makefile`: convenience commands.
- `.env.example`: required environment variables.

## Runtime Services

- `web-node`: browser/API app on port `3000`.
- `media-ingestion-node`: internal ingestion boundary on port `3100`.
- `ai-media-python-api`: internal health API on port `8000`.
- Temporal: `7233`; Temporal UI: `8080`.
- MinIO API: `9000`; MinIO console: `9001`.
- Mailpit UI: `8025`.
- Grafana: `3001`; Prometheus: `9090`.

## Last Known Validation

See `VALIDATION.md`. Validation status changes more often now because the repository includes real worker-driven auto-clipping and TTS flows. Treat `VALIDATION.md` plus recent troubleshooting notes as the current baseline, especially for long-running provider, Docker, and FFmpeg-related regressions.
