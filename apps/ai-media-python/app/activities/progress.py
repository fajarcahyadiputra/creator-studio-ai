import logging
from typing import Any

from temporalio import activity

from app.application.foundation_validation import validate_foundation_input
from app.domain.contracts import ProgressEvent
from app.infrastructure.callback_client import JobCallbackClient

logger = logging.getLogger(__name__)


@activity.defn
async def validate_foundation_request(payload: dict[str, Any]) -> dict[str, Any]:
    parsed = validate_foundation_input(payload)
    activity.heartbeat({"stage": "VALIDATING_SOURCE", "validated": True})
    return parsed.model_dump(mode="json")


@activity.defn
async def emit_progress(payload: dict[str, Any]) -> None:
    job_id = str(payload["job_id"])
    event = ProgressEvent.model_validate(payload["event"])
    try:
        await JobCallbackClient().send(job_id, event)
        logger.info("progress emitted", extra={"job_id": job_id, "stage": event.stage})
    except Exception:
        logger.warning(
            "progress callback failed but workflow will continue",
            extra={
                "job_id": job_id,
                "stage": event.stage,
                "event_type": event.event_type,
                "status": event.status,
            },
            exc_info=True,
        )
