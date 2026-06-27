import httpx

from app.config import get_settings
from app.domain.contracts import ClipOutputResult, ClipRenderContext


class ClipOutputClient:
    def __init__(self) -> None:
        self._settings = get_settings()

    async def fetch_render_context(self, clip_output_id: str) -> ClipRenderContext:
        url = f"{str(self._settings.WEB_INTERNAL_BASE_URL).rstrip('/')}/internal/v1/clip-outputs/{clip_output_id}/render-context"
        headers = {
            "authorization": f"Bearer {self._settings.INTERNAL_SERVICE_TOKEN}",
        }
        async with httpx.AsyncClient(timeout=self._settings.CALLBACK_TIMEOUT_SECONDS) as client:
            response = await client.get(url, headers=headers)
            response.raise_for_status()
            payload = response.json()
        return ClipRenderContext.model_validate(payload["data"])

    async def submit_result(self, clip_output_id: str, result: ClipOutputResult) -> None:
        url = f"{str(self._settings.WEB_INTERNAL_BASE_URL).rstrip('/')}/internal/v1/clip-outputs/{clip_output_id}/result"
        headers = {
            "authorization": f"Bearer {self._settings.INTERNAL_SERVICE_TOKEN}",
            "content-type": "application/json",
        }
        async with httpx.AsyncClient(timeout=self._settings.CALLBACK_TIMEOUT_SECONDS) as client:
            response = await client.post(url, headers=headers, json=result.model_dump(mode="json", exclude_none=True))
            response.raise_for_status()
