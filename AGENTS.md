# AGENTS.md

These rules apply to engineers and AI agents modifying this repository.

## Architectural boundaries

1. Node.js owns browser authentication, sessions, RBAC, billing, quotas, user-facing APIs, EJS rendering, audit logs, and workflow commands.
2. Python owns FFmpeg, FFprobe, transcription, AI inference, computer vision, scene analysis, diarization, reframing, subtitle generation, and media quality checks.
3. Never execute FFmpeg, Whisper, OpenCV, MediaPipe, YOLO, or provider inference in Node.js.
4. Never implement browser sessions, login, billing ownership, or EJS rendering in Python.
5. Never send large media binaries between services through REST. Put media in object storage and exchange object keys plus metadata.
6. Python must never download arbitrary public URLs. External-source ingestion belongs to `media-ingestion-node`.
7. Web/Node starts Temporal workflows and exposes internal callback/context endpoints. Python activities must call those endpoints instead of reaching into the database.
8. Treat `graphify-out/graph.json` as a navigation aid only. For architecture answers, query Graphify first when available, then verify every conclusion against source code before reporting or changing behavior.

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

## Auto-clipping and render pipeline rules

1. `ClipOutputRenderWorkflow` is the only supported path for final clip rendering. It must run `prepare_clip_output_render`, `execute_clip_output_render`, and `submit_clip_output_result` in that order.
2. `execute_clip_output_render` must keep rendering in Python: build subtitle sidecars, prepare layout options, run FFmpeg, probe final output, upload artifacts, write metadata, and return a `ClipOutputResult`.
3. The Node internal render-context endpoint is the source of truth for clip output inputs: candidate, transcript window, source media signed URL, render settings, and artifact upload URLs.
4. The Node internal result endpoint is the source of truth for persisting render side effects: `ClipOutput`, `MediaAsset`, `SubtitleAsset`, quality report, dimensions, duration, and final artifact references.
5. Do not generate or persist preview/thumbnail artifacts unless the product requirement explicitly returns. Current user-facing expectation is final playable clip plus subtitle and metadata artifacts.
6. Failed rerenders must not erase a previously playable final artifact. Preserve the previous renderable status and attach the latest failed attempt to the quality report.
7. `NEEDS_REVIEW` must be actionable: users should be able to retry, rerender, or delete the job/output. Do not strand jobs in a non-retryable state.
8. Auto-clipping candidate selection must avoid greetings, intros, sponsor reads, filler, repeated phrases, long setup, dangling endings, and cut sentences. Prefer complete, standalone clips with a hook in the first 1-3 seconds and a clean payoff.
9. Subtitle generation must preserve full spoken text for the current cue. `subtitle.max_lines` limits layout wrapping, not semantic truncation.
10. For 9:16 renders, default to `STANDARD` layout unless the user chooses a branded layout. `Podcast Highlight` subtitle style is the current default.
11. Split screen should be automatic and conservative: use one tracked frame when only one real face/speaker is visible; use top/bottom split only when two distinct visible faces are reliably detected.
12. Active-speaker crop must switch quickly but smoothly, keeping the current speaker's face inside frame. If confidence is low, fall back to a stable single-frame crop instead of producing empty or off-face crops.

## Object storage layout

1. New job artifacts must use this structure:
   - Clip outputs: `users/{userId}/jobs/clip-outputs/{jobId}/{clipOutputId}/...`
   - TTS outputs: `users/{userId}/jobs/tts/{jobId}/{ttsRequestId}/...`
2. Keep legacy object keys readable and deletable. Do not assume all stored artifacts use the newest layout.
3. Source media imported from YouTube or uploaded for clipping is temporary. After successful clipping, keep final clip artifacts and remove long source media when the cleanup path is available.
4. Admin media management owns cross-user media visibility and hard-delete operations. User pages should show job results, not global media management.
5. Never log signed MinIO URLs or object-storage credentials.

## Frontend and UX rules

1. User-facing pages must prioritize clarity over technical controls. Keep common settings visible and move advanced settings behind collapsed sections.
2. Auto-clipping and regenerate forms must stay in sync: same defaults, same option labels, same validation, and no duplicate inputs.
3. Use select options for constrained values such as layout template, crop strategy, hook style, CTA direction, subtitle style, subtitle position, and quality target.
4. Mobile layouts must not rely on wide tables. Use cards, horizontal scroll only where unavoidable, and keep primary actions reachable without side-scrolling.
5. Job detail should feel like a result showcase first and a technical report second. Show playable output, downloads, score, reason, and retry/regenerate actions before low-level metadata.
6. User settings must not expose AI provider credential controls. Provider, model, fallback mode, and platform credentials are managed by superadmin/admin settings.

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
