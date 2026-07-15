# AI Project Guide

This is the quick entrypoint for future AI agents working on Creator Studio AI. Read this file first, then open the focused guide that matches the task.

Always read `AGENTS.md` before changing architecture, workflow behavior, database schema, authentication, media processing, or AI-provider code.

## What this project is

Creator Studio AI is a multi-tenant creator workspace for auto-clipping, text-to-speech, transcription/subtitle authoring, result review, and admin-managed AI runtime settings. The repository includes authentication, RBAC, sessions, upload orchestration, durable job records, Temporal workflow execution, progress projection, SSE job events, secure media-ingestion boundaries, and Python workers for media/AI processing.

Phase 2 auto-clipping is now implemented as a real pipeline: structured `analysis_inputs`, transcript-first preparation, OpenAI-first candidate analysis with Python heuristic fallback, persisted `ClipCandidate` review rows, FFmpeg final clip rendering, subtitle sidecars (`SRT`, `ASS`, `VTT`, `JSON`), subtitle burn-in, clip-output persistence, export indexes, and in-place regenerate flows.

## Read By Task

- [Overview](docs/ai-guide/01-overview.md): project state, repository map, services, and current validation state.
- [Architecture Boundaries](docs/ai-guide/02-architecture-boundaries.md): mandatory Node/Python/service/database/security rules.
- [Code Map](docs/ai-guide/03-code-map.md): where important source files live and what each module owns.
- [Runtime Flows](docs/ai-guide/04-runtime-flows.md): upload, auto-clipping, progress projection, retry, and cancel flows.
- [Development And Validation](docs/ai-guide/05-development-validation.md): commands, tests, Docker ports, and migration workflow.
- [Extension Checklists](docs/ai-guide/06-extension-checklists.md): safe steps for Node features, Python activities, AI providers, and common traps.

## Non-Negotiable Rules

- Node.js owns browser authentication, sessions, RBAC, user APIs, EJS rendering, audit logs, upload commands, and workflow commands.
- Python owns FFmpeg/FFprobe, transcription, AI inference, computer vision, scene analysis, diarization, reframing, subtitle generation, and media quality checks.
- Do not send large media binaries between services through REST. Use object storage keys plus metadata.
- Python must not download arbitrary public URLs. External-source ingestion belongs behind `apps/media-ingestion-node`.
- Redis is not durable job state. PostgreSQL is authoritative for job projection.
- Validate untrusted input with Zod in TypeScript and Pydantic in Python.
- Mutating workflow commands require idempotency keys.
- Never log secrets, auth headers, cookies, OAuth tokens, signed URLs, reset tokens, or encrypted credential payloads.
- The Phase 2 analyzer runtime is configurable through admin settings and currently supports `openai_then_heuristic`, `heuristic_then_openai`, and `heuristic`.
- The heuristic analyzer is Python-local scoring logic, not a second external AI provider.
- Long-running provider calls must heartbeat and respect realistic timeout budgets such as `OPENAI_TIMEOUT_SECONDS` and `ANALYZER_TIMEOUT_SECONDS`.

## First Files To Read

For general architecture:

1. `AGENTS.md`
2. `README.md`
3. `docs/product-blueprint.md`
4. `docs/architecture.md`
5. `docs/workflows.md`
6. `docs/security.md`

For code changes, start from the focused files listed in [Code Map](docs/ai-guide/03-code-map.md).
