import asyncio
import logging

from temporalio.client import Client
from temporalio.worker import Worker

from app.activities.progress import emit_progress, validate_foundation_request
from app.config import get_settings
from app.observability.logging import configure_logging
from app.workflows.foundation_auto_clipping import FoundationAutoClippingWorkflow


async def main() -> None:
    configure_logging()
    settings = get_settings()
    client = await Client.connect(settings.TEMPORAL_ADDRESS, namespace=settings.TEMPORAL_NAMESPACE)
    worker = Worker(
        client,
        task_queue=settings.TEMPORAL_AUTO_CLIP_TASK_QUEUE,
        workflows=[FoundationAutoClippingWorkflow],
        activities=[validate_foundation_request, emit_progress],
        max_concurrent_activities=20,
    )
    logging.getLogger(__name__).info(
        "Temporal worker started", extra={"task_queue": settings.TEMPORAL_AUTO_CLIP_TASK_QUEUE}
    )
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
