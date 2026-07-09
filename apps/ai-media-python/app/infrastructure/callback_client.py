from datetime import UTC, datetime
import logging

import httpx

from app.config import get_settings
from app.domain.contracts import ProgressEvent

logger = logging.getLogger(__name__)


class JobCallbackClient:
    def __init__(self) -> None:
        self._settings = get_settings()

    async def send(self, job_id: str, event: ProgressEvent) -> None:
        payload = event.model_dump(mode="json", exclude_none=True)
        payload.setdefault("occurred_at", datetime.now(UTC).isoformat())
        url = f"{str(self._settings.WEB_INTERNAL_BASE_URL).rstrip('/')}/internal/v1/jobs/{job_id}/events"
        headers = {
            "authorization": f"Bearer {self._settings.INTERNAL_SERVICE_TOKEN}",
            "content-type": "application/json",
        }
        async with httpx.AsyncClient(timeout=self._settings.CALLBACK_TIMEOUT_SECONDS) as client:
            response = await client.post(url, headers=headers, json=payload)
            if response.status_code >= 400:
                logger.warning(
                    "job callback rejected",
                    extra={
                        "job_id": job_id,
                        "status_code": response.status_code,
                        "response_text": response.text[:4000],
                        "payload": payload,
                    },
                )
            response.raise_for_status()
