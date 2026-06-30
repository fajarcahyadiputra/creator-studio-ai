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

## External source URL is rejected

The web app now validates `EXTERNAL_URL` job sources through `media-ingestion-node` before the job record is created. Check:

- `INGESTION_ALLOWED_HOSTS` contains the intended host.
- `MEDIA_INGESTION_INTERNAL_BASE_URL` points at the internal ingestion service.
- `INTERNAL_SERVICE_TOKEN` matches between `web-node` and `media-ingestion-node`.

Inspect:

```bash
docker compose logs media-ingestion-node web-node
```

## Upload part fails with signature mismatch

Confirm the browser can reach the same S3 endpoint used when signing. Development may require `S3_PUBLIC_ENDPOINT=http://localhost:9000` while containers use `S3_ENDPOINT=http://minio:9000`.

## Uploaded asset stays in `VALIDATING`

Inspect the `MediaAsset.metadata.validation` payload in PostgreSQL or the upload-complete API response.

- `PENDING_WORKER` means the upload completed and the asset is waiting for the Python media-validation orchestration slice to pick it up.
- `QUEUED` means the Temporal media-validation workflow was started and the worker still needs to run the probe.
- `TRIGGER_FAILED` means upload completion succeeded, but Node could not start the Temporal media-validation workflow.
- A later internal validation callback should replace that with normalized FFprobe-style metadata and move the asset to `READY` or `FAILED`.

## Python worker tests fail with missing modules

If `py -3 -m pytest` fails with `ModuleNotFoundError` for packages such as `pydantic` or `temporalio`, install the Python worker dependencies from `apps/ai-media-python/pyproject.toml`:

```powershell
cd apps/ai-media-python
py -3 -m pip install -e ".[dev]"
```

If tests fail with `ModuleNotFoundError: No module named 'app'`, set `PYTHONPATH` before running pytest:

```powershell
$env:PYTHONPATH="$PWD"
py -3 -m pytest tests
```

## SSE appears stalled

Check that Redis is reachable and fetch `/api/v1/jobs/:jobId/events` directly. The polling endpoint reads durable PostgreSQL events even if Redis pub/sub was interrupted.

## Password reset email is missing

Open Mailpit at `http://localhost:8025`, then inspect the email worker logs:

```bash
docker compose logs web-email-worker mailpit
```
