from __future__ import annotations

import logging
from typing import Any

from app.domain.auto_clip_stages import STAGE_WEIGHTS, TOTAL_STAGE_WEIGHT, compute_overall_progress
from app.domain.contracts import ProgressEvent
from app.infrastructure.callback_client import JobCallbackClient

logger = logging.getLogger(__name__)
MAX_WARNING_MESSAGE_LENGTH = 1800
MAX_TECHNICAL_MESSAGE_LENGTH = 1500


async def emit_retry_warning(
    *,
    job_id: str | None,
    stage: str,
    stage_progress: int,
    error: Exception,
    user_message: str,
    status: str | None = "RUNNING",
    metadata: dict[str, Any] | None = None,
) -> None:
    if not job_id:
        return

    technical_message = _truncate_text(str(error), MAX_TECHNICAL_MESSAGE_LENGTH)
    warning_message = _truncate_text(
        f"{stage} attempt failed: {type(error).__name__}: {error}",
        MAX_WARNING_MESSAGE_LENGTH,
    )

    event = ProgressEvent(
        stage=stage,
        stage_progress=stage_progress,
        overall_progress=compute_overall_progress(stage, stage_progress),
        event_type="job.warning",
        message=warning_message,
        user_message=user_message,
        status=status,
        metadata={
            "stage_weight": STAGE_WEIGHTS[stage],
            "total_stage_weight": TOTAL_STAGE_WEIGHT,
            "retrying": True,
            "error_type": type(error).__name__,
            "technical_message": technical_message,
            **(metadata or {}),
        },
    )

    try:
        await JobCallbackClient().send(job_id, event)
    except Exception:
        logger.warning(
            "retry warning callback failed",
            extra={
                "job_id": job_id,
                "stage": stage,
            },
            exc_info=True,
        )


def _truncate_text(value: str, limit: int) -> str:
    normalized = value.strip()
    if len(normalized) <= limit:
        return normalized
    return f"{normalized[: max(0, limit - 14)].rstrip()}...[truncated]"
