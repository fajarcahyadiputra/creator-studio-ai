# Creator Studio AI — Product and Architecture Blueprint

This document follows the requested delivery order. Detailed implementation notes live in the linked topic documents.

## 1. Product understanding

Creator Studio AI is a multi-tenant creator workspace for durable media jobs: long-video auto clipping, text-to-speech, transcription/subtitle authoring, result review, download, and official-platform publishing. Users may use platform-owned AI credentials or encrypted credentials of their own. Superadmins operate the platform and may enter an audit-safe view-as-user context without replacing their actor identity.

## 2. Assumptions and architecture decisions

- Node.js is a modular monolith for browser-facing concerns, business records, billing/quota, job commands, and projections.
- Python owns AI inference and media processing. FFmpeg, Whisper, OpenCV, scene detection, and rendering never run in Node.
- Temporal owns durable execution; PostgreSQL owns product-facing state; MinIO/S3 owns media bytes.
- BullMQ is restricted to short jobs such as email, webhooks, notifications, and publish polling.
- Large media never crosses service REST APIs. Services exchange object keys and short-lived signed URLs.
- SSE is the default progress channel with cursor-based polling fallback.
- Provider capabilities and credentials are resolved through adapters, not hard-coded into use cases.
- Shared-schema multi-tenancy is used initially; every tenant query enforces ownership.

## 3. Architecture diagram

```mermaid
flowchart TB
  Browser[Browser / EJS / Vanilla JS] --> Edge[Nginx or Ingress]
  Edge --> Web[web-node modular monolith]
  Browser -. multipart presigned upload .-> Object[(MinIO / S3)]
  Web --> DB[(PostgreSQL)]
  Web --> Redis[(Redis)]
  Web --> Object
  Web --> Temporal[(Temporal)]
  Web --> Bull[BullMQ]
  Temporal --> Python[Python Temporal workers]
  Python --> Object
  Python --> AI[AI provider adapters]
  Web --> Ingestion[media-ingestion-node]
  Ingestion --> Sources[Allowed external sources]
  Ingestion --> Object
  Web --> OTel[OpenTelemetry]
  Python --> OTel
  Ingestion --> OTel
  OTel --> Prometheus
  OTel --> Loki
  Prometheus --> Grafana
  Loki --> Grafana
```

## 4. Auto-clipping workflow

```mermaid
flowchart TD
  A[VALIDATING_SOURCE] --> B{External source?}
  B -->|Yes| C[INGESTING_SOURCE]
  B -->|No| D[PROBING_MEDIA]
  C --> D
  D --> E[EXTRACTING_AUDIO]
  E --> F[TRANSCRIBING]
  F --> G[DIARIZING_OR_SPEAKER_ANALYSIS]
  F --> H[DETECTING_SCENES]
  F --> I[DETECTING_SILENCE]
  G --> J[ANALYZING_CLIP_CANDIDATES]
  H --> J
  I --> J
  J --> K[NORMALIZING_BOUNDARIES]
  K --> L[RANKING_AND_DEDUPLICATING]
  L --> M[GENERATING_PREVIEWS]
  M --> N[REFRAMING]
  N --> O[GENERATING_SUBTITLES]
  O --> P[RENDERING_FINAL_CLIPS]
  P --> Q[QUALITY_CHECK]
  Q -->|Pass| R[GENERATING_METADATA]
  Q -->|Warning| S[NEEDS_REVIEW]
  R --> T[UPLOADING_OUTPUTS]
  T --> U[COMPLETED]
```

Phase 1 includes the durable workflow envelope, progress projection, cancellation, and attempts. It intentionally ends as `NEEDS_REVIEW` until Phase 2 media activities are enabled.

## 5. Final repository structure

```text
creator-studio-ai/
├── apps/
│   ├── web-node/
│   ├── media-ingestion-node/
│   └── ai-media-python/
├── packages/
│   └── contracts/
├── infra/
│   ├── docker/
│   ├── kubernetes/
│   ├── monitoring/
│   └── scripts/
├── docs/
├── AGENTS.md
├── CONTRIBUTING.md
├── README.md
├── .env.example
├── docker-compose.yml
└── Makefile
```

## 6. Modules and responsibilities

| Module | Responsibility |
|---|---|
| auth | Registration, login, Google OAuth, verification, reset, session rotation |
| users | Profile, locale, timezone, security preferences |
| jobs | State, stages, events, attempts, retry, cancel, SSE |
| uploads | Multipart session, presigned parts, completion and abort |
| auto-clipping | Request validation, snapshots, workflow start, duplicate/regenerate |
| ai-providers | Providers, models, capabilities, routing, encrypted credential resolution |
| media-library | Media metadata, ownership, retention, signed preview/download |
| publishing | Connections, destinations, capability flags, background publishing |
| billing | Plans, quota reservation/settlement, usage records |
| audit | Security and administrative action history |
| ingestion | Legally allowed external retrieval and SSRF-safe validation |
| Python worker | Durable AI/media activities and provider/media adapters |

## 7. Database ERD and Prisma schema

```mermaid
erDiagram
  USER ||--o{ USER_ROLE : has
  ROLE ||--o{ USER_ROLE : assigned
  ROLE ||--o{ ROLE_PERMISSION : grants
  PERMISSION ||--o{ ROLE_PERMISSION : includes
  USER ||--o{ SESSION : owns
  USER ||--o{ PROJECT : creates
  USER ||--o{ MEDIA_ASSET : owns
  USER ||--o{ JOB : creates
  AI_PROVIDER ||--o{ AI_MODEL : provides
  AI_MODEL ||--o{ AI_MODEL_CAPABILITY : supports
  JOB ||--o{ JOB_STAGE : contains
  JOB ||--o{ JOB_EVENT : emits
  JOB ||--o{ JOB_ATTEMPT : retries
  JOB ||--o{ CLIP_CANDIDATE : proposes
  JOB ||--o{ CLIP_OUTPUT : produces
  MEDIA_ASSET ||--o{ TRANSCRIPT : has
  TRANSCRIPT ||--o{ TRANSCRIPT_SEGMENT : contains
  CLIP_OUTPUT ||--o{ SUBTITLE_ASSET : has
```

The complete schema is in `apps/web-node/prisma/schema.prisma`; the baseline migration is in `apps/web-node/prisma/migrations/202606260001_init/migration.sql`.

## 8. Job state machine

```mermaid
stateDiagram-v2
  [*] --> DRAFT
  DRAFT --> UPLOADING
  DRAFT --> QUEUED
  UPLOADING --> QUEUED
  QUEUED --> RUNNING
  RUNNING --> PAUSE_REQUESTED
  PAUSE_REQUESTED --> PAUSED
  PAUSED --> QUEUED
  RUNNING --> CANCEL_REQUESTED
  QUEUED --> CANCEL_REQUESTED
  CANCEL_REQUESTED --> CANCELED
  RUNNING --> FAILED
  FAILED --> QUEUED: retry stage
  RUNNING --> NEEDS_REVIEW
  NEEDS_REVIEW --> QUEUED: regenerate
  RUNNING --> PARTIALLY_COMPLETED
  RUNNING --> COMPLETED
  COMPLETED --> [*]
  CANCELED --> [*]
```

Completed jobs are never ambiguously restarted. Duplicate creates a new job; manual retry creates a new attempt/workflow ID.

## 9. Main API contract

Base path: `/api/v1`.

- Auth: register, login, logout, verify email, forgot/reset password, Google OAuth, current identity.
- Uploads: create multipart upload, complete, abort.
- Jobs: list/detail, events, SSE stream, cancel, retry.
- Auto clipping: create and duplicate.
- Internal: service-authenticated progress projection.

Mutating workflow operations require `Idempotency-Key`. Errors use a stable envelope containing `code`, safe `message`, `request_id`, and optional `details`.

## 10. UI sitemap and principal pages

```text
/auth: login, register, verify, forgot/reset
/app/dashboard
/app/tools/auto-clipping
/app/tools/text-to-speech
/app/tools/transcription
/app/jobs/:jobId
/app/media
/app/publishing
/app/presets
/app/usage
/app/settings/*
/admin/dashboard
/admin/users
/admin/roles
/admin/jobs
/admin/providers
/admin/models
/admin/credentials
/admin/plans
/admin/audit-logs
/admin/workers
/admin/settings
```

The auto-clipping form uses a four-step wizard: Source, Content Strategy, Visual & Subtitle, Review & Submit. Quick mode precedes advanced controls.

## 11. Threat model and security checklist

Primary threats are account takeover, broken object authorization, secret leakage, malicious media, SSRF, workflow/quota abuse, prompt injection, and unsafe impersonation. Implemented foundations include Argon2id, secure sessions, rotation, CSRF, rate limits, RBAC, ownership filtering, audit context, log redaction, presigned upload, service authentication, and SSRF-aware ingestion validation. Production mTLS, KMS integration, malware engine selection, enforced superadmin TOTP, and a penetration test remain release gates.

## 12. Docker Compose development

Compose includes PostgreSQL, Redis, MinIO/init, Temporal/UI, migration and seed jobs, Node web/email worker, ingestion service, Python API/worker, Mailpit, Prometheus, Grafana, Loki, and OpenTelemetry Collector. Web starts only after the migration job succeeds. Destructive migrations are never automatic.

## 13. Kubernetes production plan

- Separate deployments for web, ingestion, BullMQ worker, CPU Temporal worker, and optional GPU worker.
- Migration as a dedicated Job.
- HPA for web request load and worker backlog/schedule-to-start latency.
- Readiness, liveness, startup probes, PDB, resource requests/limits, service accounts, and NetworkPolicy.
- Managed/HA PostgreSQL, Redis, Temporal, and object storage rather than single containers.
- External secret manager/KMS, ingress TLS, private internal services, and controlled ingestion egress.

## 14. Roadmap

1. Phase 1: foundation included in this repository.
2. Phase 2: FFprobe, faster-whisper, scene/silence analysis, structured analyzer, crop, subtitle, render, quality checks.
3. Phase 3: active-speaker tracking, split-screen, advanced reframing, editor, brand presets.
4. Phase 4: TTS provider abstraction, duration assistance, transcript editor, subtitle translation/burn-in.
5. Phase 5: official publishing, quota settlement/billing, autoscaling, provider routing, and cost dashboards.

## 15. Phase 1 source code

Phase 1 source is implemented file-by-file in this repository. Start with `README.md`, then read `AGENTS.md`, `docs/architecture.md`, `docs/workflows.md`, and `docs/security.md` before extending the code.
