# Database

## Design principles

- UUID primary keys.
- Millisecond integer timestamps for media boundaries.
- `currentStage` is separate from overall job status.
- Immutable event and attempt records.
- Optimistic `version` fields on concurrently edited aggregates.
- Soft deletion only for recoverable user-facing resources.
- Binary media never enters PostgreSQL.

## Main aggregates

- Identity: `User`, `Role`, `Permission`, `UserRole`, `RolePermission`, `Session`, OAuth and verification tokens.
- Provider configuration: `AiProvider`, `AiModel`, `AiModelCapability`, `EncryptedCredential`, `UserAiPreference`.
- Work: `Project`, `Job`, `JobStage`, `JobEvent`, `JobAttempt`, `JobError`.
- Media: `MediaAsset`, `UploadSession`, `Transcript`, `TranscriptSegment`, `SubtitleAsset`.
- Auto clipping: `AutoClipRequest`, `ClipCandidate`, `ClipOutput`.
- TTS/transcription: `TtsRequest`, `TtsOutput`, `TranscriptionRequest`.
- Publishing: `SocialConnection`, `PublishDestination`, `PublishJob`.
- Commercial/operations: `Plan`, `Quota`, `UsageRecord`, `Notification`, `WebhookEndpoint`, `AuditLog`, `FeatureFlag`, `SystemSetting`.

## Event sequence

`Job.eventSequence` is incremented transactionally. The resulting value is used as the unique `(jobId, sequence)` cursor for SSE and polling.

## Migration safety

Production migration jobs run `prisma migrate deploy`. Web pods never execute migrations. Destructive changes use expand-and-contract releases.
