# Contributing

## Branch and commit expectations

Use focused branches and conventional commit prefixes such as `feat`, `fix`, `refactor`, `test`, `docs`, and `chore`.

## Before opening a pull request

```bash
npm run typecheck
npm test
npm run lint
cd apps/ai-media-python
python -m ruff check .
python -m mypy app
python -m pytest
```

## Pull request checklist

- Scope and trade-offs are documented.
- No Node/Python boundary violation.
- No media binary is transported through service REST APIs.
- New endpoints have authentication, authorization, validation, rate limiting where needed, and consistent errors.
- New workflow/activity logic has timeout, retry, idempotency, cancellation, progress, and cleanup.
- Database changes include reviewed migrations.
- Secrets and signed URLs are redacted.
- Tests cover failure paths, not only happy paths.
