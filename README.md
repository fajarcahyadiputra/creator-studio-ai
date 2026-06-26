# Creator Studio AI

Production-oriented foundation for a content-creator platform that orchestrates long-running media workflows with Node.js, Python, Temporal, PostgreSQL, Redis, and S3-compatible object storage.

## Scope of this ZIP

This repository implements **Phase 1 — Foundation**:

- Node.js 24 LTS modular monolith with Express, EJS, TypeScript strict mode, Prisma 7, PostgreSQL, Redis, BullMQ, SSE, and Pino.
- Email/password authentication, email verification, password reset, Google OAuth wiring, secure sessions, CSRF, rate limiting, RBAC, audit logs, and audit-safe view-as-user.
- Presigned multipart upload directly from browser to MinIO using the S3 API.
- Generic job framework, durable Temporal workflow starter, progress projection, SSE stream, cancellation, and retry-as-new-attempt.
- Python 3.13 FastAPI service and Temporal worker foundation.
- Secure media-ingestion service boundary with SSRF-aware source validation.
- Full forward-looking Prisma data model for auto clipping, TTS, transcription, publishing, provider configuration, plans, quotas, notifications, and auditability.
- Docker Compose development stack and Kubernetes production baseline.
- Architecture, security, operations, troubleshooting, API, workflow, and AI-maintenance documentation.

The actual FFmpeg, faster-whisper, scene detection, reframing, subtitle rendering, and LLM clip analyzer are intentionally scheduled for Phase 2. The Phase 1 workflow finishes as `NEEDS_REVIEW` rather than pretending that clips were rendered.

## Technology baseline

- Node.js 24 LTS
- Python 3.13
- PostgreSQL 17
- Redis 7
- Prisma ORM 7
- Temporal Server 1.29.x for local development
- MinIO as S3-compatible development object storage

## Quick start

Requirements:

- Docker Desktop with Docker Compose v2
- At least 8 GB RAM available to Docker

```bash
cp .env.example .env
```

Replace development secrets in `.env`, especially:

```text
SESSION_SECRET
CSRF_SECRET
INTERNAL_SERVICE_TOKEN
CREDENTIAL_MASTER_KEY_BASE64
ADMIN_PASSWORD
```

Generate a 32-byte base64 encryption key:

```bash
openssl rand -base64 32
```

Start the environment:

```bash
docker compose up --build
```

Open:

- Web: http://localhost:3000
- Mailpit: http://localhost:8025
- MinIO console: http://localhost:9001
- Temporal UI: http://localhost:8080
- Grafana: http://localhost:3001
- Prometheus: http://localhost:9090

Seed the superadmin if the seed container did not run automatically:

```bash
docker compose run --rm seed
```

## Local development without Docker for application processes

Start PostgreSQL, Redis, MinIO, and Temporal through Docker, then:

```bash
npm install
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
npm run dev:web
```

Python worker:

```bash
cd apps/ai-media-python
python -m venv .venv
. .venv/bin/activate
pip install -e '.[dev]'
python -m app.worker
```

## Main commands

```bash
npm run build
npm run typecheck
npm test
npm run lint
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
npm run migration:validate
```

## Default admin

The admin is created from `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Change the password immediately outside local development and enable TOTP when the Phase 1.1 security increment is enabled.

## Repository rules

Read `docs/product-blueprint.md` for the ordered architecture deliverable and `AGENTS.md` before changing architecture or adding an AI/media feature. The Node/Python and media-transfer boundaries are mandatory.

## Validation

See `VALIDATION.md` for the commands and limitations validated before packaging.
