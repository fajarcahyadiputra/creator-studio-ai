from __future__ import annotations

from typing import Any

import httpx
from temporalio import activity
from temporalio.exceptions import ApplicationError

from app.application.tts_segmentation import generate_tts_segments
from app.config import get_settings
from app.domain.contracts import TtsRequestPayload


@activity.defn
async def execute_tts_segmentation(payload: dict[str, Any]) -> dict[str, Any]:
    input_snapshot = payload.get("input_snapshot")
    job_id = str(payload["job_id"]) if isinstance(payload.get("job_id"), str) else None
    if job_id is None or not isinstance(input_snapshot, dict):
        raise ApplicationError("job_id and input_snapshot are required", non_retryable=True, type="InvalidInput")

    request = TtsRequestPayload.model_validate(
        {
            "job_id": job_id,
            "script": input_snapshot.get("script"),
            "language": input_snapshot.get("language", "id"),
            "local_model_key": input_snapshot.get("local_model_key"),
            "voice_identifier": input_snapshot.get("voice_identifier"),
            "speaking_style": input_snapshot.get("speaking_style"),
            "emotion": input_snapshot.get("emotion"),
            "speaking_speed": input_snapshot.get("speaking_speed"),
            "pitch": input_snapshot.get("pitch"),
            "pause_intensity": input_snapshot.get("pause_intensity"),
            "target_duration_ms": input_snapshot.get("target_duration_ms"),
            "pronunciation_dictionary": input_snapshot.get("pronunciation_dictionary") or {},
            "output_config": input_snapshot.get("output_config") or {},
        }
    )
    user_preferences = (
        input_snapshot.get("user_preferences")
        if isinstance(input_snapshot.get("user_preferences"), dict)
        else {}
    )
    result = await generate_tts_segments(request=request, user_preferences=user_preferences)
    document = result.get("document")
    segment_count = (
        len(document["segments"])
        if isinstance(document, dict) and isinstance(document.get("segments"), list)
        else 0
    )
    activity.heartbeat(
        {
            "job_id": job_id,
            "segment_count": segment_count,
            "language": request.language,
        }
    )
    return result


@activity.defn
async def submit_tts_segmentation_result(payload: dict[str, Any]) -> None:
    job_id = payload.get("job_id")
    document = payload.get("document")
    metadata = payload.get("metadata")
    if not isinstance(job_id, str) or not isinstance(document, dict):
        raise ApplicationError("job_id and document are required", non_retryable=True, type="InvalidInput")

    settings = get_settings()
    url = f"{str(settings.WEB_INTERNAL_BASE_URL).rstrip('/')}/internal/v1/jobs/{job_id}/tts-segmentation-result"
    headers = {
        "authorization": f"Bearer {settings.INTERNAL_SERVICE_TOKEN}",
        "content-type": "application/json",
    }
    body = {
        "document": document,
        "metadata": metadata if isinstance(metadata, dict) else {},
    }

    async with httpx.AsyncClient(timeout=settings.CALLBACK_TIMEOUT_SECONDS) as client:
        response = await client.post(url, headers=headers, json=body)
        response.raise_for_status()

    segment_count = len(document.get("segments", [])) if isinstance(document.get("segments"), list) else 0
    activity.heartbeat({"job_id": job_id, "segment_count": segment_count})
