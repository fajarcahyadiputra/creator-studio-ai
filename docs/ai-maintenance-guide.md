# AI Maintenance Guide

## How to understand the project quickly

1. Read `AGENTS.md`.
2. Read `docs/architecture.md` and ADRs.
3. Inspect `schema.prisma` for aggregate ownership.
4. Follow a request from route to controller/service/repository.
5. Follow a job from Node Temporal client to Python workflow and internal progress projection.

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
