from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from app.activities.progress import emit_progress, validate_foundation_request


ACTIVITY_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=1),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(seconds=20),
    maximum_attempts=5,
    non_retryable_error_types=["InvalidInput", "RightsNotConfirmed"],
)


@workflow.defn(name="FoundationAutoClippingWorkflow")
class FoundationAutoClippingWorkflow:
    @workflow.run
    async def run(self, raw_input: dict[str, Any]) -> dict[str, Any]:
        job_id = str(raw_input["job_id"])
        await self._emit(
            job_id,
            {
                "stage": "VALIDATING_SOURCE",
                "stage_progress": 5,
                "overall_progress": 1,
                "event_type": "job.started",
                "message": "Validating the durable workflow input.",
                "user_message": "Validating source and job settings.",
                "status": "RUNNING",
                "metadata": {"attempt_number": raw_input.get("attempt_number", 1)},
            },
        )
        validated = await workflow.execute_activity(
            validate_foundation_request,
            raw_input,
            start_to_close_timeout=timedelta(seconds=30),
            heartbeat_timeout=timedelta(seconds=10),
            retry_policy=ACTIVITY_RETRY,
        )
        await self._emit(
            job_id,
            {
                "stage": "VALIDATING_SOURCE",
                "stage_progress": 100,
                "overall_progress": 5,
                "event_type": "job.progress",
                "message": "Foundation input passed schema and rights validation.",
                "user_message": "Source settings are valid.",
                "status": "RUNNING",
                "metadata": {"job_type": validated["job_type"]},
            },
        )
        await self._emit(
            job_id,
            {
                "stage": "PROBING_MEDIA",
                "stage_progress": 0,
                "overall_progress": 5,
                "event_type": "job.needs_review",
                "message": (
                    "FFprobe and media activities are intentionally disabled in the Phase 1 foundation."
                ),
                "user_message": (
                    "The durable workflow is ready. Enable Phase 2 media workers to process clips."
                ),
                "status": "NEEDS_REVIEW",
                "metadata": {"phase": "FOUNDATION", "next_phase": "AUTO_CLIPPING_MVP"},
            },
        )
        return {
            "job_id": job_id,
            "status": "NEEDS_REVIEW",
            "phase": "FOUNDATION",
            "message": "No media output was fabricated by the Phase 1 workflow.",
        }

    async def _emit(self, job_id: str, event: dict[str, Any]) -> None:
        await workflow.execute_activity(
            emit_progress,
            {"job_id": job_id, "event": event},
            start_to_close_timeout=timedelta(seconds=20),
            retry_policy=ACTIVITY_RETRY,
        )
