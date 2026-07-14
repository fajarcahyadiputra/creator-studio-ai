from __future__ import annotations

import asyncio
import logging

from app.worker import main as worker_main

logger = logging.getLogger(__name__)


def _run_worker() -> None:
    try:
        asyncio.run(worker_main())
    except asyncio.CancelledError:
        logger.info("Development worker cancelled")
    except KeyboardInterrupt:
        logger.info("Development worker interrupted")


if __name__ == "__main__":
    logger.info("Development worker started without internal file watcher")
    _run_worker()
