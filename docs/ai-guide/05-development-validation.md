# Development And Validation

Use these commands when changing this repository.

## Docker Stack

```bash
cp .env.example .env
docker compose up --build
```

Open:

- Web: `http://localhost:3000`
- Mailpit: `http://localhost:8025`
- MinIO console: `http://localhost:9001`
- Temporal UI: `http://localhost:8080`
- Grafana: `http://localhost:3001`
- Prometheus: `http://localhost:9090`

Seed superadmin if needed:

```bash
docker compose run --rm seed
```

## Root Node Commands

```bash
npm run build
npm run typecheck
npm test
npm run lint
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
npm run migration:validate
```

## Python Commands

```bash
cd apps/ai-media-python
py -3 -m pytest
py -3 -m ruff check .
py -3 -m mypy app
```

## Make Targets

```bash
make setup
make up
make down
make logs
make ps
make migrate
make seed
make test
make typecheck
make lint
make format
```

## Tests Currently Present

- Node web: auth password hashing and job state machine tests.
- Node ingestion: SSRF/IP URL security tests.
- Python: clip scoring, FFmpeg helper, and foundation validation tests.

## Required Test Shape For New Work

- Business-rule unit test.
- Authorization/ownership test for sensitive endpoints.
- Contract test for Node/Python messages.
- Retry, cancellation, and idempotency test for workflow changes.
- Migration validation for schema changes.

## Migration Workflow

1. Change `apps/web-node/prisma/schema.prisma` first.
2. Generate a named migration.
3. Review SQL manually.
4. Validate migration SQL.
5. Never run destructive migrations automatically at web startup.
6. Use expand-and-contract migrations for production breaking changes.

Relevant files:

- `apps/web-node/prisma/schema.prisma`
- `apps/web-node/prisma/migrations/*/migration.sql`
- `infra/scripts/validate-migration.mjs`

## Local Development Without Docker For App Processes

Start PostgreSQL, Redis, MinIO, and Temporal through Docker, then:

```bash
npm install
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
npm run dev:web
```

Python worker:

```bash
cd apps/ai-media-python
py -3 -m venv .venv
.venv\Scripts\activate
py -3 -m pip install -e ".[dev]"
py -3 -m app.worker
```

If you are using PowerShell on Windows and `python` is not callable but `py` is, prefer `py -3` for every command above.

For ad-hoc test runs outside an activated virtualenv, set `PYTHONPATH` so `app` imports resolve:

```powershell
$env:PYTHONPATH="$PWD\apps\ai-media-python"
py -3 -m pytest apps/ai-media-python/tests
```
