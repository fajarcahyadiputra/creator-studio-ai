from __future__ import annotations

from typing import Any

from temporalio import activity
from temporalio.exceptions import ApplicationError

from app.domain.contracts import ClipOutputResult
from app.infrastructure.clip_output_client import ClipOutputClient


@activity.defn
async def prepare_clip_output_render(payload: dict[str, Any]) -> dict[str, Any]:
    clip_output_id = payload.get("clip_output_id")
    if not isinstance(clip_output_id, str) or not clip_output_id:
        raise ApplicationError("clip_output_id is required", non_retryable=True, type="InvalidInput")

    context = await ClipOutputClient().fetch_render_context(clip_output_id)
    activity.heartbeat(
        {
            "clip_output_id": context.clip_output_id,
            "job_id": context.job_id,
            "candidate_id": context.candidate_id,
        }
    )

    # Placeholder preparation result for the upcoming render workflow slice.
    return {
        "clip_output_id": context.clip_output_id,
        "job_id": context.job_id,
        "candidate_id": context.candidate_id,
        "render_settings": context.render_settings,
        "candidate": context.candidate.model_dump(mode="json"),
        "output_targets": context.output_targets.model_dump(mode="json"),
    }


@activity.defn
async def submit_clip_output_result(payload: dict[str, Any]) -> None:
    clip_output_id = payload.get("clip_output_id")
    result = payload.get("result")
    if not isinstance(clip_output_id, str) or not isinstance(result, dict):
        raise ApplicationError("clip output result payload is required", non_retryable=True, type="InvalidInput")
    parsed = ClipOutputResult.model_validate(result)
    await ClipOutputClient().submit_result(clip_output_id, parsed)
