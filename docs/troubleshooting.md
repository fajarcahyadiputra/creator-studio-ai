# Troubleshooting

## Web starts before migrations

Check the `migrate` container. The web service depends on its successful completion. Run:

```bash
docker compose logs migrate
```

## Prisma client is missing

```bash
npm run prisma:generate
```

Prisma 7 generates the client into `apps/web-node/src/generated/prisma`.

## Temporal connection fails

Verify `TEMPORAL_ADDRESS`, then open Temporal UI and ensure the namespace exists. Inspect:

```bash
docker compose logs temporal ai-media-python web-node
```

## Upload part fails with signature mismatch

Confirm the browser can reach the same S3 endpoint used when signing. Development may require `S3_PUBLIC_ENDPOINT=http://localhost:9000` while containers use `S3_ENDPOINT=http://minio:9000`.

## SSE appears stalled

Check that Redis is reachable and fetch `/api/v1/jobs/:jobId/events` directly. The polling endpoint reads durable PostgreSQL events even if Redis pub/sub was interrupted.

## Password reset email is missing

Open Mailpit at `http://localhost:8025`, then inspect the email worker logs:

```bash
docker compose logs web-email-worker mailpit
```
