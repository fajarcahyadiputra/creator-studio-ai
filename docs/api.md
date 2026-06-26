# API

Base path: `/api/v1`

## Error envelope

```json
{
  "error": {
    "code": "JOB_STAGE_FAILED",
    "message": "The transcription stage failed.",
    "request_id": "uuid",
    "details": {}
  }
}
```

## Authentication

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/logout`
- `POST /auth/forgot-password`
- `POST /auth/reset-password`
- `GET /auth/verify-email`
- `GET /auth/google`
- `GET /auth/google/callback`
- `GET /auth/me`
- `GET /auth/csrf`

## Uploads

- `POST /uploads` creates a multipart upload and presigned part URLs.
- `POST /uploads/:uploadId/complete` validates parts and completes upload.
- `POST /uploads/:uploadId/abort` aborts an unfinished upload.

## Jobs

- `GET /jobs`
- `GET /jobs/:jobId`
- `GET /jobs/:jobId/events`
- `GET /jobs/:jobId/events/stream`
- `POST /jobs/:jobId/cancel`
- `POST /jobs/:jobId/retry`

## Auto clipping

- `POST /auto-clipping/jobs`
- `POST /auto-clipping/jobs/:jobId/duplicate`

Create, retry, duplicate, publishing, and upload-initiation endpoints require `Idempotency-Key`.

## Internal worker API

- `POST /internal/v1/jobs/:jobId/events`
- `GET /internal/v1/health`

Internal endpoints require `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` and are never exposed by the production ingress.
