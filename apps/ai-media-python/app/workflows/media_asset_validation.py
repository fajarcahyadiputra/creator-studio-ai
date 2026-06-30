from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from app.activities.media_validation import (
        prepare_media_asset_validation,
        probe_media_asset_validation,
        submit_media_asset_validation_result,
    )


ACTIVITY_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=1),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(seconds=20),
    maximum_attempts=5,
    non_retryable_error_types=["InvalidInput"],
)


@workflow.defn(name="MediaAssetValidationWorkflow")
class MediaAssetValidationWorkflow:
    @workflow.run
    async def run(self, raw_input: dict[str, Any]) -> dict[str, Any]:
        media_asset_id = raw_input.get("media_asset_id")
        if not isinstance(media_asset_id, str) or not media_asset_id:
            raise ValueError("media_asset_id is required")

        context = await workflow.execute_activity(
            prepare_media_asset_validation,
            {"media_asset_id": media_asset_id},
            start_to_close_timeout=timedelta(seconds=30),
            heartbeat_timeout=timedelta(seconds=10),
            retry_policy=ACTIVITY_RETRY,
        )

        result = await workflow.execute_activity(
            probe_media_asset_validation,
            context,
            start_to_close_timeout=timedelta(seconds=60),
            heartbeat_timeout=timedelta(seconds=15),
            retry_policy=ACTIVITY_RETRY,
        )

        await workflow.execute_activity(
            submit_media_asset_validation_result,
            {"media_asset_id": media_asset_id, "result": result},
            start_to_close_timeout=timedelta(seconds=30),
            heartbeat_timeout=timedelta(seconds=10),
            retry_policy=ACTIVITY_RETRY,
        )

        return {
            "media_asset_id": media_asset_id,
            "status": result.get("status"),
            "duration_ms": result.get("duration_ms"),
        }
