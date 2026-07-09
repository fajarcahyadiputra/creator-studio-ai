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
- `GET /jobs/:jobId/outputs`
- `GET /jobs/:jobId/export-index`
- `GET /jobs/:jobId/outputs/:clipOutputId/export-index`
- `GET /jobs/:jobId/events`
- `GET /jobs/:jobId/events/stream`
- `POST /jobs/:jobId/cancel`
- `POST /jobs/:jobId/candidates/:candidateId/selection`
- `POST /jobs/:jobId/render-queue`
- `POST /jobs/:jobId/retry`

## Auto clipping

- `POST /auto-clipping/jobs`
- `POST /auto-clipping/jobs/:jobId/duplicate`

Create, retry, duplicate, publishing, and upload-initiation endpoints require `Idempotency-Key`.

### `GET /jobs/:jobId/outputs`

Returns the structured Phase 2 output payload attached to a job.

```json
{
  "data": {
    "job_id": "uuid",
    "status": "COMPLETED",
    "candidate_count": 3,
    "clip_candidates": [
      {
        "id": "uuid",
        "candidate_id": "candidate-01-abcdef12",
        "start_ms": "12500",
        "end_ms": "39100",
        "duration_ms": "26600",
        "title": "Kenapa hook ini bikin orang berhenti scroll",
        "final_viral_score": "8.15",
        "selected": true,
        "rank": 1
      }
    ],
    "output_summary": {
      "analysis_version": "2.0",
      "source_summary": "Ringkasan isi sumber yang dipakai analyzer.",
      "candidate_count": 3,
      "analyzer": {
        "analysis_mode": "openai",
        "prompt_version": "phase2-candidate-analyzer-v1"
      },
      "candidates": [
        {
          "candidate_id": "candidate-01-abcdef12",
          "start_seconds": 12.5,
          "end_seconds": 39.1,
          "duration_seconds": 26.6,
          "title": "Kenapa hook ini bikin orang berhenti scroll",
          "hook_text": "Kenapa kebanyakan konten gagal di 3 detik pertama?",
          "ending_text": "Itu yang bikin retention-nya naik.",
          "summary": "....",
          "why_it_works": ["Opens with a clear hook."],
          "content_category": "insight",
          "context_complete": true,
          "safety_notes": [],
          "suggested_caption": "....",
          "suggested_cta": "Watch until the end and share your take.",
          "suggested_hashtags": ["#creatorstudio", "#shortclips"],
          "thumbnail_text": "Kenapa hook ini bikin orang berhenti scroll",
          "speaker_ids": ["speaker-1"],
          "scene_ids": ["scene-2"],
          "scores": {}
        }
      ]
    },
    "clip_outputs": [
      {
        "id": "uuid",
        "candidate_id": "candidate-row-1",
        "quality_status": "PASSED",
        "duration_ms": "27500",
        "width": 1080,
        "height": 1920,
        "output_summary": {
          "aspect_ratio": "9:16",
          "renderer": "ffmpeg-worker-v1",
          "render_status": "completed",
          "validation_status": "passed",
          "output_playable": true,
          "preview_playable": true,
          "resolution_matches_target": true,
          "audio_present": true,
          "video_codec_matches_target": true,
          "audio_codec_matches_target": true,
          "duration_within_tolerance": true,
          "subtitle_export_ready": true,
          "subtitle_cue_count": 5,
          "final_duration_ms": 27500,
          "final_video_codec": "h264",
          "final_audio_codec": "aac",
          "preview_duration_ms": 27480,
          "subtitle_format": "ass",
          "subtitle_language": "id",
          "subtitle_burned_in": true,
          "validation_warnings": []
        },
        "subtitles": [
          {
            "id": "uuid",
            "format": "srt",
            "language": "id",
            "artifact": "subtitle_srt",
            "object_key": "jobs/job-1/clip-outputs/output-1/subtitle.srt",
            "is_burned_in": false,
            "created_at": "2026-06-26T10:04:30.000Z"
          }
        ]
      }
    ]
  }
}
```

`clip_candidates` reflects the persisted relational review rows when available. `output_summary` is `null` until the workflow has attached a Phase 2 result. `clip_outputs` stays empty until rendered clips are persisted.

### `GET /jobs/:jobId/export-index`

Returns a structured JSON export index for every clip output attached to the job. Each clip output entry includes all currently available signed artifact URLs such as preview, final video, metadata, thumbnail, and per-format subtitles.

### `GET /jobs/:jobId/outputs/:clipOutputId/export-index`

Returns a structured JSON export index for one clip output and all of its currently available signed artifact URLs.

### `POST /jobs/:jobId/render-queue`

Creates pending `ClipOutput` rows for selected candidates that do not already have one. This queues render preparation metadata only; it does not render the clip inside Node.js.

## Internal worker API

- `POST /internal/v1/jobs/:jobId/events`
- `GET /internal/v1/clip-outputs/:clipOutputId/render-context`
- `POST /internal/v1/clip-outputs/:clipOutputId/result`
- `GET /internal/v1/health`

Internal endpoints require `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` and are never exposed by the production ingress.
