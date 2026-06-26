# Extension Checklists

Use these checklists before editing and before final validation.

## Node-Facing Feature

1. Add or update Zod schemas for untrusted input.
2. Keep routes/controllers thin.
3. Put behavior in use cases/services.
4. Enforce ownership using `userId` or tenant-owned aggregate traversal.
5. Use application services instead of direct imports from another module's internals.
6. Write structured logs without secrets.
7. Add business-rule tests.
8. Add authorization/ownership tests for sensitive endpoints.
9. Return stable error envelopes without stack traces.

## Python Media Or AI Activity

1. Define Pydantic input/output contracts.
2. Use object keys, not media bytes over REST.
3. Add Temporal start-to-close timeout.
4. Add heartbeat timeout for long work.
5. Add retry policy and non-retryable error classification.
6. Accept an idempotency key.
7. Check cancellation.
8. Clean temporary files in `finally`.
9. Emit structured progress.
10. Store outputs under versioned object keys.
11. Add workflow and activity tests.

## AI Provider

1. Add provider/model metadata through `AiProvider`, `AiModel`, and capabilities.
2. Implement provider behavior behind a Python adapter interface.
3. Do not branch on `provider === "openai"` inside business use cases.
4. Resolve credentials through the credential resolver.
5. Never pass stored encrypted blobs to workflow history.
6. Record prompt version, provider, model, request ID, latency, token usage, and estimated cost.
7. Add contract and schema-validation tests.

## Temporal Activity

1. Keep workflows deterministic.
2. Set start-to-close and heartbeat timeouts.
3. Add retry policy.
4. Classify retryable versus non-retryable failures.
5. Emit structured progress.
6. Accept an idempotency key.
7. Check cancellation.
8. Clean temporary files in `finally`.
9. Store output under a versioned object key.
10. Add a workflow test and an activity test.

## Common Traps

- Do not treat Redis as durable job state.
- Do not put media binaries in database rows or service REST calls.
- Do not expose raw stack traces in user-facing job messages.
- Do not log cookies, authorization headers, API keys, OAuth tokens, signed URLs, reset tokens, or encrypted credential payloads.
- Do not bypass service-auth on `/internal/*`.
- Do not mutate completed outputs in place; write a new versioned object key.
- Do not skip idempotency keys for workflow-starting commands.
- Do not add direct imports into another module's internals when an exported service boundary is available.
- Do not soft-delete every table; use soft delete only where recovery or audit requirements justify it.

## Definition Of Done

A change is done only when it has:

- Validation.
- Error handling.
- Tests.
- Logs without secrets.
- Documentation for operational impact.
- Safe rollback or migration plan.
