from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from app.activities.render_outputs import (
        execute_clip_output_render,
        prepare_clip_output_render,
        submit_clip_output_result,
    )


ACTIVITY_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=1),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(seconds=20),
    maximum_attempts=5,
    non_retryable_error_types=["InvalidInput"],
)


@workflow.defn(name="ClipOutputRenderWorkflow")
class ClipOutputRenderWorkflow:
    @workflow.run
    async def run(self, raw_input: dict[str, Any]) -> dict[str, Any]:
        clip_output_id = raw_input.get("clip_output_id")
        if not isinstance(clip_output_id, str) or not clip_output_id:
            raise ValueError("clip_output_id is required")

        context = await workflow.execute_activity(
            prepare_clip_output_render,
            {"clip_output_id": clip_output_id},
            start_to_close_timeout=timedelta(seconds=30),
            heartbeat_timeout=timedelta(seconds=10),
            retry_policy=ACTIVITY_RETRY,
        )

        result = await workflow.execute_activity(
            execute_clip_output_render,
            context,
            start_to_close_timeout=timedelta(seconds=30),
            heartbeat_timeout=timedelta(seconds=10),
            retry_policy=ACTIVITY_RETRY,
        )

        await workflow.execute_activity(
            submit_clip_output_result,
            {"clip_output_id": clip_output_id, "result": result},
            start_to_close_timeout=timedelta(seconds=30),
            heartbeat_timeout=timedelta(seconds=10),
            retry_policy=ACTIVITY_RETRY,
        )

        return {
            "clip_output_id": clip_output_id,
            "quality_status": result.get("quality_status"),
            "preview_object_key": result.get("preview_object_key"),
        }
