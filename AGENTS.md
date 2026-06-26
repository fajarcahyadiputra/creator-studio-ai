# AGENTS.md

These rules apply to engineers and AI agents modifying this repository.

## Architectural boundaries

1. Node.js owns browser authentication, sessions, RBAC, billing, quotas, user-facing APIs, EJS rendering, audit logs, and workflow commands.
2. Python owns FFmpeg, FFprobe, transcription, AI inference, computer vision, scene analysis, diarization, reframing, subtitle generation, and media quality checks.
3. Never execute FFmpeg, Whisper, OpenCV, MediaPipe, YOLO, or provider inference in Node.js.
4. Never implement browser sessions, login, billing ownership, or EJS rendering in Python.
5. Never send large media binaries between services through REST. Put media in object storage and exchange object keys plus metadata.
6. Python must never download arbitrary public URLs. External-source ingestion belongs to `media-ingestion-node`.

## Module rules

- Controllers are thin and contain no business rules.
- Use cases/services own application behavior.
- Repositories encapsulate persistence only where that abstraction improves testing or boundaries.
- Cross-module access goes through exported application services, not direct imports from another module's internals.
- Validate all untrusted input with Zod or Pydantic.
- Use UUIDs externally and do not expose sequential database identifiers.

## Adding an AI provider

1. Add provider and model metadata through `AiProvider`, `AiModel`, and capabilities.
2. Implement the provider behind an adapter interface in Python.
3. Never branch on `provider === "openai"` inside business use cases.
4. Resolve credentials through the credential resolver; never pass stored encrypted blobs to workflow history.
5. Record prompt version, provider, model, request ID, latency, token usage, and estimated cost.
6. Add contract and schema-validation tests.

## Adding a Temporal activity

1. Keep activities deterministic only where required; workflows themselves must remain deterministic.
2. Set start-to-close and heartbeat timeouts.
3. Add a retry policy and classify retryable versus non-retryable failures.
4. Emit structured progress.
5. Accept an idempotency key.
6. Check cancellation and clean temporary files in `finally`.
7. Store output under a versioned object key.
8. Add a workflow test and an activity test.

## Database migrations

- Change `schema.prisma` first.
- Generate a named migration.
- Review SQL manually.
- Never run destructive migrations automatically at web startup.
- Add expand-and-contract migrations for production breaking changes.
- Do not soft-delete every table. Use it only where recovery or audit requirements justify it.

## Logging and redaction

- Use structured logs.
- Include request ID, trace ID, user ID, job ID, workflow ID, and activity ID where available.
- Never log passwords, cookies, authorization headers, API keys, OAuth tokens, signed URLs, reset tokens, or encrypted credential payloads.
- User-facing job messages must not contain stack traces.

## Required tests

- Business-rule unit test.
- Authorization/ownership test for sensitive endpoints.
- Contract test for Node/Python messages.
- Retry, cancellation, and idempotency test for workflow changes.
- Migration validation for schema changes.

## Definition of done

A change is done only when it has validation, error handling, tests, logs without secrets, documentation for operational impact, and a safe rollback or migration plan.
