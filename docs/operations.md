# Operations

## Startup order

1. PostgreSQL, Redis, MinIO, and Temporal become healthy.
2. MinIO initialization creates the media bucket.
3. Migration job runs `prisma migrate deploy`.
4. Seed job creates roles, permissions, plan, and initial admin.
5. Web, email worker, ingestion service, Python API, and Python Temporal worker start.

## Graceful shutdown

Web stops accepting new HTTP requests, closes SSE streams, drains the server, then disconnects Redis, Temporal, and Prisma. Workers stop polling before exiting.

## Backups

- PostgreSQL: daily full backup plus WAL/PITR in production.
- Object storage: versioning/replication and lifecycle policies.
- Redis: not a business source of truth, but persistence is recommended for BullMQ durability.
- Temporal: use a supported production persistence deployment and backup strategy.

## Alerts

- HTTP 5xx and latency spike.
- Job failure-rate spike.
- Temporal schedule-to-start latency.
- Worker heartbeat missing.
- BullMQ waiting/failed backlog.
- PostgreSQL connection exhaustion.
- Redis, MinIO, or Temporal unavailable.
- Provider failure or latency spike.
- Storage threshold and orphan-object growth.

## Reconciliation

A scheduled admin process compares active Temporal workflows, PostgreSQL jobs, upload sessions, and temporary object prefixes. It reports orphaned records before any deletion action.
