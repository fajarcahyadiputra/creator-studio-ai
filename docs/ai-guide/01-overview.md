# Overview

This repository is a monorepo foundation for a creator-focused media and AI platform. The current implementation is Phase 1: durable platform scaffolding, not full media rendering.

## Current Project State

Implemented:

- Node.js 24 Express/EJS modular monolith.
- Email/password authentication, session handling, CSRF, rate limiting, RBAC foundations, audit-safe impersonation.
- Multipart browser upload directly to MinIO/S3 through presigned URLs.
- Job records, attempts, stages, events, cancel/retry/duplicate commands.
- Temporal workflow startup from Node.
- Python Temporal worker foundation.
- Progress callbacks from Python to Node internal API.
- PostgreSQL-backed progress projection with SSE updates.
- Media-ingestion service boundary with SSRF-aware URL validation.
- Forward-looking Prisma schema for media, AI providers, credentials, usage, publishing, notifications, quotas, and audit.
- Docker Compose development stack and monitoring baseline.

Not implemented yet:

- Real FFprobe/FFmpeg auto-clipping pipeline.
- Faster Whisper transcription.
- Scene/silence detection.
- Reframing and subtitle rendering.
- LLM clip analysis.
- Official publishing flow.
- Billing/quota settlement business behavior.

The Phase 1 auto-clipping workflow deliberately ends with `NEEDS_REVIEW`.

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

See `VALIDATION.md`. At packaging time, TypeScript typecheck/build, Node tests, Python tests, Ruff, strict mypy, Prisma validation, and migration validation passed. Full Docker Compose integration boot was not executed in that environment.
