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

If the error contains `getaddrinfo EAI_AGAIN youtu.be`, that is typically a temporary DNS resolution failure for the short YouTube domain. Retry the request, or use the canonical full URL format instead:

```text
https://www.youtube.com/watch?v=VIDEO_ID
```

In the current development boundary, trusted YouTube hosts already listed in `INGESTION_ALLOWED_HOSTS` may still be accepted when the only failure is a temporary public DNS lookup error inside the ingestion container. In that case the ingestion service responds with `validation_mode: trusted_host_dns_bypass` and writes a warning log. If non-YouTube hosts fail this way, fix container DNS rather than expanding the bypass.

Inspect:

```bash
docker compose logs media-ingestion-node web-node
```

## External source import fails with DNS or host resolution errors

If auto-clipping fails with messages such as:

- `Name or service not known`
- `Temporary failure in name resolution`
- `The read operation timed out`

then the source video import worker could reach the internal app services, but failed when resolving or downloading the public media host from inside Docker.

Check:

- `ai-media-python` is attached to the `public` network as well as `internal`
- Docker Desktop is running and outbound DNS works inside containers
- after compose changes, the worker containers were recreated, not only restarted

Recommended commands:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --force-recreate ai-media-python ai-media-python-api media-ingestion-node web-node
docker compose logs ai-media-python web-node media-ingestion-node
```

Notes:

- The Python worker now uses more conservative `yt-dlp` download settings for long-form source imports.
- TTS segmentation now falls back to `local_heuristic` if the OpenAI host cannot be resolved, so DNS issues should no longer hard-fail the entire TTS workflow.

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
