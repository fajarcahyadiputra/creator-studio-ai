import httpx

from app.config import get_settings
from app.domain.contracts import (
    ExternalSourceImportContext,
    MediaAssetValidationContext,
    MediaAssetValidationResult,
    TtsOutputPersistenceRequest,
    TtsOutputTargetRequest,
    TtsOutputTarget,
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

    async def create_external_source_import(
        self,
        *,
        job_id: str,
        user_id: str,
        project_id: str | None,
        source_url: str,
        display_name: str,
        original_file_name: str,
        mime_type: str,
        extension: str,
    ) -> ExternalSourceImportContext:
        url = f"{str(self._settings.WEB_INTERNAL_BASE_URL).rstrip('/')}/internal/v1/external-source-imports"
        headers = {
            "authorization": f"Bearer {self._settings.INTERNAL_SERVICE_TOKEN}",
            "content-type": "application/json",
        }
        payload = {
            "job_id": job_id,
            "user_id": user_id,
            "source_url": source_url,
            "display_name": display_name,
            "original_file_name": original_file_name,
            "mime_type": mime_type,
            "extension": extension,
        }
        if project_id is not None:
            payload["project_id"] = project_id
        async with httpx.AsyncClient(timeout=self._settings.CALLBACK_TIMEOUT_SECONDS) as client:
            response = await client.post(url, headers=headers, json=payload)
            response.raise_for_status()
            body = response.json()
        return ExternalSourceImportContext.model_validate(body["data"])

    async def complete_external_source_import(
        self,
        media_asset_id: str,
        *,
        status: str,
        size_bytes: int | None,
        checksum_sha256: str | None,
        mime_type: str,
        extension: str,
        display_name: str,
        original_file_name: str,
        result: MediaAssetValidationResult,
    ) -> None:
        url = (
            f"{str(self._settings.WEB_INTERNAL_BASE_URL).rstrip('/')}"
            f"/internal/v1/external-source-imports/{media_asset_id}/complete"
        )
        headers = {
            "authorization": f"Bearer {self._settings.INTERNAL_SERVICE_TOKEN}",
            "content-type": "application/json",
        }
        payload = {
            "status": status,
            "size_bytes": str(size_bytes) if size_bytes is not None else None,
            "checksum_sha256": checksum_sha256,
            "mime_type": mime_type,
            "extension": extension,
            "display_name": display_name,
            "original_file_name": original_file_name,
            "duration_ms": result.duration_ms,
            "width": result.width,
            "height": result.height,
            "frame_rate": result.frame_rate,
            "audio_sample_rate": result.audio_sample_rate,
            "codec_name": result.codec_name,
            "audio_codec_name": result.audio_codec_name,
            "rotation": result.rotation,
            "metadata": result.metadata,
            "failure_reason": result.failure_reason,
        }
        payload = {key: value for key, value in payload.items() if value is not None}
        async with httpx.AsyncClient(timeout=self._settings.CALLBACK_TIMEOUT_SECONDS) as client:
            response = await client.post(url, headers=headers, json=payload)
            response.raise_for_status()

    async def create_tts_output_target(self, job_id: str, preferred_format: str = "wav") -> TtsOutputTarget:
        url = f"{str(self._settings.WEB_INTERNAL_BASE_URL).rstrip('/')}/internal/v1/jobs/{job_id}/tts-output-target"
        headers = {
            "authorization": f"Bearer {self._settings.INTERNAL_SERVICE_TOKEN}",
            "content-type": "application/json",
        }
        payload = TtsOutputTargetRequest(preferred_format=preferred_format)
        async with httpx.AsyncClient(timeout=self._settings.CALLBACK_TIMEOUT_SECONDS) as client:
            response = await client.post(
                url,
                headers=headers,
                json=payload.model_dump(mode="json"),
            )
            response.raise_for_status()
            body = response.json()
        return TtsOutputTarget.model_validate(body["data"])

    async def submit_tts_output_result(
        self,
        job_id: str,
        payload: TtsOutputPersistenceRequest,
    ) -> None:
        url = f"{str(self._settings.WEB_INTERNAL_BASE_URL).rstrip('/')}/internal/v1/jobs/{job_id}/tts-output-result"
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
