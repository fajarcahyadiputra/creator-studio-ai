import asyncio
import logging

from temporalio.client import Client
from temporalio.worker import Worker

from app.activities.phase2_analysis import analyze_phase2_candidates, prepare_analysis_inputs
from app.activities.progress import emit_progress, validate_foundation_request
from app.activities.render_outputs import prepare_clip_output_render, submit_clip_output_result
from app.config import get_settings
from app.observability.logging import configure_logging
from app.workflows.foundation_auto_clipping import FoundationAutoClippingWorkflow


async def main() -> None:
    configure_logging()
    settings = get_settings()
    if settings.AUTO_CLIP_ANALYZER_MODE.lower() == "openai" and not settings.OPENAI_API_KEY:
        logging.getLogger(__name__).warning(
            "OpenAI analyzer mode is enabled without OPENAI_API_KEY; heuristic fallback will be used"
        )
    client = await Client.connect(settings.TEMPORAL_ADDRESS, namespace=settings.TEMPORAL_NAMESPACE)
    worker = Worker(
        client,
        task_queue=settings.TEMPORAL_AUTO_CLIP_TASK_QUEUE,
        workflows=[FoundationAutoClippingWorkflow],
        activities=[
            validate_foundation_request,
            emit_progress,
            prepare_analysis_inputs,
            analyze_phase2_candidates,
            prepare_clip_output_render,
            submit_clip_output_result,
        ],
        max_concurrent_activities=20,
    )
    logging.getLogger(__name__).info(
        "Temporal worker started", extra={"task_queue": settings.TEMPORAL_AUTO_CLIP_TASK_QUEUE}
    )
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
