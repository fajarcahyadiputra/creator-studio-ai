from __future__ import annotations

import asyncio
import json
from typing import Any

from temporalio import activity
from temporalio.exceptions import ApplicationError

from app.config import get_settings
from app.domain.contracts import MediaAssetValidationContext, MediaAssetValidationResult
from app.infrastructure.media_asset_client import MediaAssetClient
from app.media.ffmpeg import ProbeSummary, build_ffprobe_command, summarize_ffprobe_payload


@activity.defn
async def prepare_media_asset_validation(payload: dict[str, Any]) -> dict[str, Any]:
    media_asset_id = payload.get("media_asset_id")
    if not isinstance(media_asset_id, str) or not media_asset_id:
        raise ApplicationError("media asset id is required", non_retryable=True, type="InvalidInput")

    context = await MediaAssetClient().fetch_validation_context(media_asset_id)
    activity.heartbeat(
        {
            "media_asset_id": context.media_asset_id,
            "object_key": context.object_key,
            "mime_type": context.mime_type,
        }
    )
    return context.model_dump(mode="json")


@activity.defn
async def probe_media_asset_validation(payload: dict[str, Any]) -> dict[str, Any]:
    context = MediaAssetValidationContext.model_validate(payload)
    settings = get_settings()

    activity.heartbeat(
        {
            "media_asset_id": context.media_asset_id,
            "stage": "PROBING_MEDIA",
            "download_url": str(context.download_url),
        }
    )

    try:
        probe_payload = await run_ffprobe_json(
            str(context.download_url),
            timeout_seconds=settings.MEDIA_PROBE_TIMEOUT_SECONDS,
        )
        summary = summarize_ffprobe_payload(probe_payload)
        result = build_media_asset_validation_result(
            summary,
            mime_type=context.mime_type,
            metadata=context.metadata,
        )
    except Exception as error:
        result = MediaAssetValidationResult(
            status="FAILED",
            metadata={
                "source": "ffprobe",
                "object_key": context.object_key,
                "probe_failure_type": type(error).__name__,
            },
            failure_reason=f"Media probe failed: {error}",
        )

    activity.heartbeat(
        {
            "media_asset_id": context.media_asset_id,
            "status": result.status,
            "duration_ms": result.duration_ms,
        }
    )
    return result.model_dump(mode="json", exclude_none=True)


@activity.defn
async def submit_media_asset_validation_result(payload: dict[str, Any]) -> None:
    media_asset_id = payload.get("media_asset_id")
    result = payload.get("result")
    if not isinstance(media_asset_id, str) or not isinstance(result, dict):
        raise ApplicationError("media asset validation payload is required", non_retryable=True, type="InvalidInput")

    parsed = MediaAssetValidationResult.model_validate(result)
    await MediaAssetClient().submit_validation_result(media_asset_id, parsed)
    activity.heartbeat(
        {
            "media_asset_id": media_asset_id,
            "status": parsed.status,
            "duration_ms": parsed.duration_ms,
        }
    )


async def run_ffprobe_json(source: str, *, timeout_seconds: float) -> dict[str, Any]:
    command = build_ffprobe_command(source)
    process = await asyncio.create_subprocess_exec(
        *command.as_exec_args(),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout_seconds)
    except asyncio.TimeoutError:
        process.kill()
        await process.communicate()
        raise TimeoutError("ffprobe timed out")

    if process.returncode != 0:
        message = stderr.decode("utf-8", errors="replace").strip() or "ffprobe exited with a non-zero status"
        raise RuntimeError(message)

    try:
        payload = json.loads(stdout.decode("utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError("ffprobe did not return valid JSON") from error

    if not isinstance(payload, dict):
        raise ValueError("ffprobe payload must be a JSON object")
    return payload


def build_media_asset_validation_result(
    summary: ProbeSummary,
    *,
    mime_type: str | None,
    metadata: dict[str, Any] | None,
) -> MediaAssetValidationResult:
    failure_reasons: list[str] = []
    lowered_mime_type = (mime_type or "").lower()

    if summary.duration_ms is None:
        failure_reasons.append("Media duration could not be determined.")
    if lowered_mime_type.startswith("video/") and not summary.has_audio:
        failure_reasons.append("No audio stream was detected for the uploaded video.")

    base_metadata = metadata if isinstance(metadata, dict) else {}
    merged_metadata = {
        **base_metadata,
        "validation": {
            **(
                base_metadata.get("validation")
                if isinstance(base_metadata.get("validation"), dict)
                else {}
            ),
            "source": "ffprobe",
            "has_audio": summary.has_audio,
        },
    }

    return MediaAssetValidationResult(
        status="FAILED" if failure_reasons else "READY",
        duration_ms=str(summary.duration_ms) if summary.duration_ms is not None else None,
        width=summary.width,
        height=summary.height,
        frame_rate=summary.frame_rate,
        audio_sample_rate=summary.audio_sample_rate,
        codec_name=summary.codec_name,
        audio_codec_name=summary.audio_codec_name,
        rotation=summary.rotation,
        metadata=merged_metadata,
        failure_reason=" ".join(failure_reasons) if failure_reasons else None,
    )
