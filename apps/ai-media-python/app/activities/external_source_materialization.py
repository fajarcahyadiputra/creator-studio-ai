from __future__ import annotations

import asyncio
import hashlib
import logging
import mimetypes
import re
from pathlib import Path
from typing import Any

import httpx
from temporalio import activity
from temporalio.exceptions import ApplicationError
from yt_dlp import YoutubeDL

from app.config import get_settings
from app.activities.media_validation import build_media_asset_validation_result, run_ffprobe_json
from app.domain.contracts import MediaAssetValidationResult
from app.infrastructure.media_asset_client import MediaAssetClient
from app.media.ffmpeg import summarize_ffprobe_payload

logger = logging.getLogger(__name__)


@activity.defn
async def materialize_external_source(payload: dict[str, Any]) -> dict[str, Any]:
    job_id = _require_string(payload.get("job_id"), "job_id")
    user_id = _require_string(payload.get("user_id"), "user_id")
    source_url = _require_string(payload.get("source_url"), "source_url")
    project_id = payload.get("project_id")
    if project_id is not None and not isinstance(project_id, str):
        raise ApplicationError("project_id must be a string when provided", non_retryable=True, type="InvalidInput")

    settings = get_settings()
    workdir = Path(settings.TEMP_WORKDIR) / user_id / job_id / "external-source"
    workdir.mkdir(parents=True, exist_ok=True)

    info = await _await_with_heartbeat(
        asyncio.to_thread(_extract_source_info, source_url),
        {
            "job_id": job_id,
            "stage": "PROBING_MEDIA",
            "action": "extracting_external_source_info",
            "source_url": source_url,
        },
        interval_seconds=10,
    )
    base_name = _safe_file_stem(info.get("title")) or f"external-source-{job_id[:8]}"
    download_template = str(workdir / f"{base_name}.%(ext)s")
    downloaded_path = await _await_with_heartbeat(
        asyncio.to_thread(_download_source_media, source_url, download_template),
        {
            "job_id": job_id,
            "stage": "PROBING_MEDIA",
            "action": "downloading_external_source",
            "source_url": source_url,
        },
        interval_seconds=10,
    )

    original_file_name = downloaded_path.name
    extension = downloaded_path.suffix.lstrip(".").lower() or "mp4"
    mime_type = mimetypes.guess_type(downloaded_path.name)[0] or "video/mp4"
    display_name = _safe_display_name(info.get("title")) or downloaded_path.stem

    client = MediaAssetClient()
    import_context = await client.create_external_source_import(
        job_id=job_id,
        user_id=user_id,
        project_id=project_id,
        source_url=source_url,
        display_name=display_name,
        original_file_name=original_file_name,
        mime_type=mime_type,
        extension=extension,
    )

    activity.heartbeat(
        {
            "job_id": job_id,
            "media_asset_id": import_context.media_asset_id,
            "stage": "PROBING_MEDIA",
            "action": "downloaded_external_source",
            "path": str(downloaded_path),
        }
    )

    checksum_sha256: str | None = _hash_file(downloaded_path)
    size_bytes: int | None = downloaded_path.stat().st_size

    try:
        await _await_with_heartbeat(
            _upload_file(import_context.upload_url, downloaded_path, mime_type),
            {
                "job_id": job_id,
                "media_asset_id": import_context.media_asset_id,
                "stage": "PROBING_MEDIA",
                "action": "uploading_external_source",
            },
            interval_seconds=10,
        )
        await _await_with_heartbeat(
            _verify_uploaded_object(import_context.read_url),
            {
                "job_id": job_id,
                "media_asset_id": import_context.media_asset_id,
                "stage": "PROBING_MEDIA",
                "action": "verifying_uploaded_external_source",
                "object_key": import_context.object_key,
            },
            interval_seconds=10,
        )
        probe_payload = await run_ffprobe_json(str(downloaded_path), timeout_seconds=settings.MEDIA_PROBE_TIMEOUT_SECONDS)
        summary = summarize_ffprobe_payload(probe_payload)
        result = build_media_asset_validation_result(
            summary,
            mime_type=mime_type,
            metadata={
                "source": "external-url-import",
                "source_url": source_url,
                "provider": "yt-dlp",
                "extractor": info.get("extractor"),
                "webpage_url": info.get("webpage_url") or source_url,
            },
        )

        await client.complete_external_source_import(
            import_context.media_asset_id,
            status=result.status,
            size_bytes=size_bytes,
            checksum_sha256=checksum_sha256,
            mime_type=mime_type,
            extension=extension,
            display_name=display_name,
            original_file_name=original_file_name,
            result=result,
        )

        if result.status != "READY":
            raise ApplicationError(
                result.failure_reason or "External source import did not pass validation.",
                non_retryable=True,
                type="ExternalSourceImportFailed",
            )

        return {
            "media_asset_id": import_context.media_asset_id,
            "object_key": import_context.object_key,
            "display_name": display_name,
            "mime_type": mime_type,
            "extension": extension,
            "size_bytes": str(size_bytes),
            "checksum_sha256": checksum_sha256,
        }
    except Exception as error:
        logger.warning(
            "external source materialization failed",
            extra={"job_id": job_id, "source_url": source_url},
            exc_info=True,
        )
        failure_result = {
            "status": "FAILED",
            "duration_ms": None,
            "width": None,
            "height": None,
            "frame_rate": None,
            "audio_sample_rate": None,
            "codec_name": None,
            "audio_codec_name": None,
            "rotation": None,
            "metadata": {
                "source": "external-url-import",
                "source_url": source_url,
                "provider": "yt-dlp",
            },
            "failure_reason": str(error),
        }
        if 'import_context' in locals():
            await client.complete_external_source_import(
                import_context.media_asset_id,
                status="FAILED",
                size_bytes=size_bytes if downloaded_path.exists() else None,
                checksum_sha256=checksum_sha256 if downloaded_path.exists() else None,
                mime_type=mime_type,
                extension=extension,
                display_name=display_name,
                original_file_name=original_file_name,
                result=MediaAssetValidationResult.model_validate(failure_result),
            )
        raise
    finally:
        for child in workdir.glob("*"):
            if child.is_file():
                child.unlink(missing_ok=True)


def _extract_source_info(source_url: str) -> dict[str, Any]:
    with YoutubeDL(
        {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "noplaylist": True,
            "extractor_args": {
                "youtube": {
                    "player_client": ["android", "web"],
                }
            },
            "http_headers": {
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
                ),
                "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
            },
        }
    ) as ydl:
        info = ydl.extract_info(source_url, download=False)
    if not isinstance(info, dict):
        raise RuntimeError("yt-dlp did not return a source info document")
    return info


def _download_source_media(source_url: str, output_template: str) -> Path:
    with YoutubeDL(
        {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "format": "bv*+ba/b",
            "merge_output_format": "mp4",
            "outtmpl": output_template,
            "restrictfilenames": True,
            "extractor_args": {
                "youtube": {
                    "player_client": ["android", "web"],
                }
            },
            "http_headers": {
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
                ),
                "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
            },
        }
    ) as ydl:
        ydl.download([source_url])

    candidates = sorted(Path(output_template).parent.iterdir())
    files = [candidate for candidate in candidates if candidate.is_file()]
    if not files:
        raise RuntimeError("yt-dlp completed without producing a local media file")
    return max(files, key=lambda item: item.stat().st_size)


async def _await_with_heartbeat(
    awaitable: Any,
    details: dict[str, Any],
    *,
    interval_seconds: int,
):
    task = asyncio.create_task(awaitable)
    while True:
        try:
            return await asyncio.wait_for(asyncio.shield(task), timeout=interval_seconds)
        except TimeoutError:
            activity.heartbeat(details)


async def _upload_file(upload_url: str, file_path: Path, content_type: str) -> None:
    payload = await asyncio.to_thread(file_path.read_bytes)
    async with httpx.AsyncClient(timeout=None) as client:
        response = await client.put(
            str(upload_url),
            content=payload,
            headers={"content-type": content_type},
        )
        response.raise_for_status()


async def _verify_uploaded_object(read_url: str) -> None:
    async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
        response = await client.get(
            str(read_url),
            headers={"range": "bytes=0-0"},
        )
        response.raise_for_status()


def _hash_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _require_string(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ApplicationError(f"{field_name} is required", non_retryable=True, type="InvalidInput")
    return value.strip()


def _safe_display_name(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    normalized = re.sub(r"\s+", " ", value).strip()
    return normalized[:255]


def _safe_file_stem(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("._-")
    return normalized[:120]
