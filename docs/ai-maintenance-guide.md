# AI Maintenance Guide

## How to understand the project quickly

1. Read `AGENTS.md`.
2. Read `AI_PROJECT_GUIDE.md`.
3. Read `docs/ai-guide/02-architecture-boundaries.md` and `docs/ai-guide/03-code-map.md`.
4. Read `docs/architecture.md` and ADRs.
5. Inspect `schema.prisma` for aggregate ownership.
6. Follow a request from route to controller/service/repository.
7. Follow a job from Node Temporal client to Python workflow and internal progress projection.

## Safe change sequence

1. Restate the boundary and invariant affected.
2. Change or add a contract first.
3. Add validation and failure classifications.
4. Implement the smallest application behavior.
5. Add tests for authorization, idempotency, and failure paths.
6. Update documentation and operations notes.

## Common prohibited changes

- Running media tools inside web-node.
- Passing API keys in workflow input.
- Logging signed URLs.
- Fetching arbitrary URLs in Python.
- Treating Redis pub/sub as durable event storage.
- Resetting a completed job to running.
- Overwriting an existing clip output during retry.

## Focused onboarding notes

When a task is specific, prefer the focused guide instead of rereading everything:

- `docs/ai-guide/01-overview.md`
- `docs/ai-guide/03-code-map.md`
- `docs/ai-guide/04-runtime-flows.md`
- `docs/ai-guide/05-development-validation.md`
- `docs/ai-guide/06-extension-checklists.md`
