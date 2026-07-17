from __future__ import annotations

import asyncio
import hashlib
import logging
import mimetypes
import re
import shutil
from pathlib import Path
from typing import Any

import httpx
from temporalio import activity
from temporalio.exceptions import ApplicationError
from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError

from app.config import get_settings
from app.activities.media_validation import build_media_asset_validation_result, run_ffprobe_json
from app.domain.contracts import MediaAssetValidationResult
from app.infrastructure.media_asset_client import MediaAssetClient
from app.media.ffmpeg import summarize_ffprobe_payload

logger = logging.getLogger(__name__)

SUPPORTED_SOURCE_VIDEO_HEIGHTS = {360, 480, 720, 1080}


def _normalize_target_video_height(value: Any) -> int:
    try:
        height = int(value)
    except (TypeError, ValueError):
        height = 1080
    if height not in SUPPORTED_SOURCE_VIDEO_HEIGHTS:
        raise ApplicationError(
            "target_video_height must be 360, 480, 720, or 1080",
            non_retryable=True,
            type="InvalidInput",
        )
    return height


def _build_source_format_selector(target_height: int) -> str:
    minimum_height = 480 if target_height >= 720 else target_height
    height_filter = f"[height<={target_height}][height>={minimum_height}]"
    return (
        f"bestvideo{height_filter}+bestaudio/"
        f"bestvideo{height_filter}[ext=mp4]+bestaudio[ext=m4a]/"
        f"best{height_filter}[ext=mp4]/"
        f"best{height_filter}"
    )


def _build_ytdlp_options(
    *,
    skip_download: bool,
    output_template: str | None = None,
    target_video_height: int = 1080,
    player_client: str | None = None,
) -> dict[str, Any]:
    options: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "http_headers": {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
            ),
            "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
        },
        "socket_timeout": 120,
        "retries": 10,
        "fragment_retries": 10,
        "file_access_retries": 5,
        "extractor_retries": 5,
    }

    if skip_download:
        options["skip_download"] = True
        return options

    if player_client:
        options["extractor_args"] = {"youtube": {"player_client": [player_client]}}

    options.update(
        {
            "format": _build_source_format_selector(target_video_height),
            "merge_output_format": "mp4",
            "outtmpl": output_template,
            "restrictfilenames": True,
            "continuedl": True,
        }
    )
    return options


@activity.defn
async def materialize_external_source(payload: dict[str, Any]) -> dict[str, Any]:
    job_id = _require_string(payload.get("job_id"), "job_id")
    user_id = _require_string(payload.get("user_id"), "user_id")
    source_url = _require_string(payload.get("source_url"), "source_url")
    target_video_height = _normalize_target_video_height(payload.get("target_video_height", 1080))
    project_id = payload.get("project_id")
    if project_id is not None and not isinstance(project_id, str):
        raise ApplicationError("project_id must be a string when provided", non_retryable=True, type="InvalidInput")

    settings = get_settings()
    workdir = Path(settings.TEMP_WORKDIR) / user_id / job_id / "external-source" / _build_activity_workdir_name()
    workdir.mkdir(parents=True, exist_ok=True)
    stage = "extract-info"

    client = MediaAssetClient()
    info: dict[str, Any] = {}
    display_name = ""
    original_file_name = ""
    extension = "mp4"
    mime_type = "video/mp4"
    import_context = None
    checksum_sha256: str | None = None
    size_bytes: int | None = None
    downloaded_path: Path | None = None
    try:
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

        stage = "download"
        downloaded_path = await _await_with_heartbeat(
            asyncio.to_thread(_download_source_media, source_url, download_template, target_video_height),
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

        stage = "create-import"
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

        checksum_sha256 = _hash_file(downloaded_path)
        size_bytes = downloaded_path.stat().st_size

        stage = "upload"
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
        stage = "verify-upload"
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
        stage = "probe"
        probe_payload = await run_ffprobe_json(str(downloaded_path), timeout_seconds=settings.MEDIA_PROBE_TIMEOUT_SECONDS)
        summary = summarize_ffprobe_payload(probe_payload)
        result = build_media_asset_validation_result(
            summary,
            mime_type=mime_type,
            metadata={
                "source": "external-url-import",
                "source_url": source_url,
                "provider": "yt-dlp",
                "requested_video_height": target_video_height,
                "minimum_video_height": 480 if target_video_height >= 720 else target_video_height,
                "extractor": info.get("extractor"),
                "webpage_url": info.get("webpage_url") or source_url,
            },
        )

        stage = "complete-import"
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
            "requested_video_height": target_video_height,
            "downloaded_video_height": result.height,
        }
    except Exception as error:
        failure_reason = _summarize_materialization_error(stage=stage, error=error)
        logger.warning(
            "external source materialization failed",
            extra={
                "job_id": job_id,
                "source_url": source_url,
                "materialization_stage": stage,
                "failure_reason": failure_reason,
                "error_type": type(error).__name__,
            },
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
                "materialization_stage": stage,
                "error_type": type(error).__name__,
            },
            "failure_reason": failure_reason,
        }
        if import_context is not None:
            try:
                await client.complete_external_source_import(
                    import_context.media_asset_id,
                    status="FAILED",
                    size_bytes=size_bytes if downloaded_path and downloaded_path.exists() else None,
                    checksum_sha256=checksum_sha256 if downloaded_path and downloaded_path.exists() else None,
                    mime_type=mime_type,
                    extension=extension,
                    display_name=display_name or f"external-source-{job_id[:8]}",
                    original_file_name=original_file_name or f"external-source-{job_id[:8]}.{extension}",
                    result=MediaAssetValidationResult.model_validate(failure_result),
                )
            except Exception as completion_error:
                logger.warning(
                    "failed to persist external source import failure",
                    extra={
                        "job_id": job_id,
                        "media_asset_id": import_context.media_asset_id,
                        "materialization_stage": "complete-import-failure",
                        "failure_reason": _summarize_materialization_error(
                            stage="complete-import-failure",
                            error=completion_error,
                        ),
                    },
                )
        raise ApplicationError(
            failure_reason,
            non_retryable=True,
            type="ExternalSourceImportFailed",
        ) from error
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def _extract_source_info(source_url: str) -> dict[str, Any]:
    with YoutubeDL(_build_ytdlp_options(skip_download=True)) as ydl:
        info = ydl.extract_info(source_url, download=False)
    if not isinstance(info, dict):
        raise RuntimeError("yt-dlp did not return a source info document")
    return info


def _download_source_media(source_url: str, output_template: str, target_video_height: int = 1080) -> Path:
    base_dir = Path(output_template).parent
    file_template = Path(output_template).name
    failures: list[str] = []

    # YouTube periodically restricts adaptive streams by player client. Keep each
    # attempt isolated so a stale .part file can never corrupt the next fallback.
    for attempt_name, player_client in (("android-vr", "android_vr"), ("default", None)):
        attempt_dir = base_dir / attempt_name
        attempt_dir.mkdir(parents=True, exist_ok=True)
        attempt_template = str(attempt_dir / file_template)
        try:
            with YoutubeDL(
                _build_ytdlp_options(
                    skip_download=False,
                    output_template=attempt_template,
                    target_video_height=target_video_height,
                    player_client=player_client,
                )
            ) as ydl:
                ydl.download([source_url])

            files = [
                candidate
                for candidate in attempt_dir.iterdir()
                if candidate.is_file() and not candidate.name.endswith((".part", ".ytdl"))
            ]
            if files:
                selected = max(files, key=lambda item: item.stat().st_size)
                logger.info(
                    "external source download strategy succeeded",
                    extra={
                        "download_strategy": attempt_name,
                        "target_video_height": target_video_height,
                        "downloaded_path": str(selected),
                    },
                )
                return selected
            failures.append(f"{attempt_name}: no media file was produced")
        except DownloadError as error:
            failures.append(f"{attempt_name}: {str(error).strip()}")
            shutil.rmtree(attempt_dir, ignore_errors=True)

    raise DownloadError("; ".join(failures))


def _build_activity_workdir_name() -> str:
    try:
        info = activity.info()
        activity_id = re.sub(r"[^a-zA-Z0-9._-]+", "-", info.activity_id).strip("-") or "activity"
        return f"{activity_id}-attempt-{info.attempt}"
    except Exception:
        return "activity-attempt-1"


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
        except asyncio.CancelledError:
            task.cancel()
            raise


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


def _summarize_materialization_error(*, stage: str, error: Exception) -> str:
    message = str(error).strip() or type(error).__name__
    if isinstance(error, DownloadError):
        return f"{stage}: yt-dlp download failed: {message}"
    if isinstance(error, httpx.HTTPStatusError):
        return (
            f"{stage}: upstream HTTP {error.response.status_code} "
            f"from {error.request.method} {error.request.url}"
        )
    if isinstance(error, httpx.RequestError):
        request = error.request
        method = request.method if request is not None else "REQUEST"
        url = str(request.url) if request is not None else "unknown-url"
        return f"{stage}: request failed during {method} {url}: {message}"
    if isinstance(error, ApplicationError):
        error_type = getattr(error, "type", None) or type(error).__name__
        return f"{stage}: {error_type}: {message}"
    return f"{stage}: {type(error).__name__}: {message}"
