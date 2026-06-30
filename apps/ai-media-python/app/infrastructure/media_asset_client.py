import httpx

from app.config import get_settings
from app.domain.contracts import (
    MediaAssetValidationContext,
    MediaAssetValidationResult,
    TranscriptionPersistenceRequest,
)


class MediaAssetClient:
    def __init__(self) -> None:
        self._settings = get_settings()

    async def fetch_validation_context(self, media_asset_id: str) -> MediaAssetValidationContext:
        url = (
            f"{str(self._settings.WEB_INTERNAL_BASE_URL).rstrip('/')}"
            f"/internal/v1/media-assets/{media_asset_id}/validation-context"
        )
        headers = {
            "authorization": f"Bearer {self._settings.INTERNAL_SERVICE_TOKEN}",
        }
        async with httpx.AsyncClient(timeout=self._settings.CALLBACK_TIMEOUT_SECONDS) as client:
            response = await client.get(url, headers=headers)
            response.raise_for_status()
            payload = response.json()
        return MediaAssetValidationContext.model_validate(payload["data"])

    async def submit_validation_result(self, media_asset_id: str, result: MediaAssetValidationResult) -> None:
        url = (
            f"{str(self._settings.WEB_INTERNAL_BASE_URL).rstrip('/')}"
            f"/internal/v1/media-assets/{media_asset_id}/validation-result"
        )
        headers = {
            "authorization": f"Bearer {self._settings.INTERNAL_SERVICE_TOKEN}",
            "content-type": "application/json",
        }
        async with httpx.AsyncClient(timeout=self._settings.CALLBACK_TIMEOUT_SECONDS) as client:
            response = await client.post(
                url,
                headers=headers,
                json=result.model_dump(mode="json", exclude_none=True),
            )
            response.raise_for_status()

    async def submit_transcription_result(
        self,
        media_asset_id: str,
        payload: TranscriptionPersistenceRequest,
    ) -> None:
        url = (
            f"{str(self._settings.WEB_INTERNAL_BASE_URL).rstrip('/')}"
            f"/internal/v1/media-assets/{media_asset_id}/transcription-result"
        )
        headers = {
            "authorization": f"Bearer {self._settings.INTERNAL_SERVICE_TOKEN}",
            "content-type": "application/json",
        }
        async with httpx.AsyncClient(timeout=self._settings.CALLBACK_TIMEOUT_SECONDS) as client:
            response = await client.post(
                url,
                headers=headers,
                json=payload.model_dump(mode="json", exclude_none=True),
            )
            response.raise_for_status()
