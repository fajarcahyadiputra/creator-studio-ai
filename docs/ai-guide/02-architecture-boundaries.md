# Architecture Boundaries

These rules are mandatory. Do not trade them away for convenience.

## Ownership Boundaries

Node.js owns:

- Browser authentication and sessions.
- RBAC and effective identity.
- Billing/quota-facing business ownership.
- User-facing APIs.
- EJS rendering.
- Audit logs and impersonation.
- Upload commands and presigned URL orchestration.
- Workflow commands such as create, cancel, retry, duplicate.

Python owns:

- FFmpeg and FFprobe.
- Whisper/transcription.
- OpenCV/computer vision.
- Scene analysis.
- Diarization.
- Reframing.
- Subtitle generation.
- Media quality checks.
- AI inference and provider adapters.

Media ingestion owns:

- External-source URL validation.
- SSRF-aware network boundary.
- Future controlled public media retrieval after rights and platform checks.

## Forbidden Moves

- Do not run FFmpeg, Whisper, OpenCV, MediaPipe, YOLO, or provider inference from Node.js.
- Do not implement browser sessions, login, billing ownership, or EJS rendering in Python.
- Do not send large media binaries over REST between services.
- Do not let Python download arbitrary public URLs.
- Do not expose sequential database identifiers externally.
- Do not treat Redis as durable job state.
- Do not bypass service authentication for `/internal/*`.
- Do not expose raw stack traces in user-facing job messages.
- Do not log passwords, cookies, authorization headers, API keys, OAuth tokens, signed URLs, reset tokens, or encrypted credential payloads.

## Data Boundaries

- PostgreSQL is the source of truth for users, roles, plans, jobs, assets, projections, and audit records.
- Temporal is the source of truth for durable workflow execution and timers.
- Object storage is the source of truth for media bytes.
- Redis is for session storage, rate counters, lightweight fan-out, and short-lived queue infrastructure.
- BullMQ is for short jobs such as email, webhook, notification, and publish polling.

## Validation Boundaries

- TypeScript validates untrusted input with Zod.
- Python validates untrusted input with Pydantic.
- Node/Python message changes should update `packages/contracts` and relevant tests.

## Multi-Tenancy And Identity

- Tenant-owned queries must include `userId` or traverse a tenant-owned aggregate.
- Signed media URLs require ownership or admin permission checks.
- Impersonation must preserve actor identity and effective user identity separately.
- Admin permission checks use the actor. Workspace data queries use the effective user.
