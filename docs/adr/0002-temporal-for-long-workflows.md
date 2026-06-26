# ADR 0002: Temporal for long workflows

Status: Accepted

Auto clipping and long transcription/TTS workflows use Temporal for durable state, retries, cancellation, timers, and restart recovery. BullMQ is limited to short tasks. PostgreSQL stores user-facing projections and audit records rather than replacing Temporal history.
