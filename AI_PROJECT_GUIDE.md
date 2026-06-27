# AI Project Guide

This is the quick entrypoint for future AI agents working on Creator Studio AI. Read this file first, then open the focused guide that matches the task.

Always read `AGENTS.md` before changing architecture, workflow behavior, database schema, authentication, media processing, or AI-provider code.

## What this project is

Creator Studio AI is currently a Phase 1 production-oriented foundation for a multi-tenant creator workspace. It includes authentication, RBAC, sessions, upload orchestration, durable job records, Temporal workflow startup, progress projection, SSE job events, secure media-ingestion boundaries, and a Python worker skeleton.

Phase 2 media processing is partially implemented. The repository now includes structured `analysis_inputs`, OpenAI-first candidate analysis with heuristic fallback, persisted `ClipCandidate` review rows, and job-output APIs/UI. Final media rendering, subtitle burn-in, and full clip-export execution are still incomplete and must not be faked.

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
- The Phase 2 analyzer currently defaults to OpenAI at runtime through `OPENAI_API_KEY`, but the provider boundary must remain adapter-based so it can be swapped later.

## First Files To Read

For general architecture:

1. `AGENTS.md`
2. `README.md`
3. `docs/product-blueprint.md`
4. `docs/architecture.md`
5. `docs/workflows.md`
6. `docs/security.md`

For code changes, start from the focused files listed in [Code Map](docs/ai-guide/03-code-map.md).
