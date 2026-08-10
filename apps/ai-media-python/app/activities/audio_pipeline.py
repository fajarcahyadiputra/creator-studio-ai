from __future__ import annotations

from contextlib import suppress
from pathlib import Path
from typing import Any
from time import monotonic

import httpx
from temporalio import activity
from temporalio.exceptions import ApplicationError

from app.config import get_settings
from app.domain.contracts import AudioExtractionPlan, AudioExtractionResult, MediaAssetValidationContext
from app.activities.warning_events import emit_retry_warning
from app.media.ffmpeg import build_audio_extraction
import asyncio


@activity.defn
async def prepare_audio_extraction(payload: dict[str, Any]) -> dict[str, Any]:
    context = MediaAssetValidationContext.model_validate(
        {
            key: payload.get(key)
            for key in (
                "media_asset_id",
                "user_id",
                "project_id",
                "type",
                "status",
                "object_key",
                "display_name",
                "original_file_name",
                "mime_type",
                "extension",
                "size_bytes",
                "checksum_sha256",
                "download_url",
                "metadata",
            )
        }
    )
    job_id = str(payload["job_id"]) if isinstance(payload.get("job_id"), str) else None
    if context.status != "READY":
        raise ApplicationError(
            "media asset must be READY before audio extraction planning",
            non_retryable=True,
            type="InvalidInput",
        )
    if not await _source_object_exists(str(context.download_url)):
        raise ApplicationError(
            "source media object could not be read from object storage",
            non_retryable=True,
            type="MissingSourceObject",
        )

    settings = get_settings()
    working_directory = Path(settings.TEMP_WORKDIR) / context.user_id / context.media_asset_id
    output_audio_path = working_directory / "audio.wav"
    command = build_audio_extraction(str(context.download_url), output_audio_path, sample_rate=16_000)

    plan = AudioExtractionPlan(
        media_asset_id=context.media_asset_id,
        job_id=job_id,
        user_id=context.user_id,
        object_key=context.object_key,
        source_url=context.download_url,
        working_directory=str(working_directory),
        output_audio_path=str(output_audio_path),
        sample_rate=16_000,
        command=command.as_exec_args(),
    )

    activity.heartbeat(
        {
            "media_asset_id": context.media_asset_id,
            "output_audio_path": str(output_audio_path),
            "sample_rate": 16_000,
        }
    )
    return plan.model_dump(mode="json")


@activity.defn
async def execute_audio_extraction(payload: dict[str, Any]) -> dict[str, Any]:
    plan = AudioExtractionPlan.model_validate(payload)
    settings = get_settings()

    output_audio_path = Path(plan.output_audio_path)
    output_audio_path.parent.mkdir(parents=True, exist_ok=True)

    process = await asyncio.create_subprocess_exec(
        *plan.command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    try:
        _stdout, stderr = await _communicate_with_heartbeat(
            process,
            plan=plan,
            timeout_seconds=float(settings.AUDIO_EXTRACTION_TIMEOUT_SECONDS),
        )
    except asyncio.TimeoutError as error:
        await _terminate_process(process)
        timeout_error = TimeoutError("ffmpeg audio extraction timed out")
        await emit_retry_warning(
            job_id=plan.job_id,
            stage="EXTRACTING_AUDIO",
            stage_progress=10,
            error=timeout_error,
            user_message="Audio extraction terlalu lama dan akan dicoba ulang otomatis.",
            metadata={
                "media_asset_id": plan.media_asset_id,
                "output_audio_path": plan.output_audio_path,
                "timeout_seconds": settings.AUDIO_EXTRACTION_TIMEOUT_SECONDS,
            },
        )
        raise timeout_error from error
    except asyncio.CancelledError:
        await _terminate_process(process)
        raise

    if process.returncode != 0:
        message = stderr.decode("utf-8", errors="replace").strip() or "ffmpeg exited with a non-zero status"
        if "404 Not Found" in message or "Server returned 404 Not Found" in message:
            missing_source_error = ApplicationError(
                "source media object could not be read from object storage",
                non_retryable=True,
                type="MissingSourceObject",
            )
            await emit_retry_warning(
                job_id=plan.job_id,
                stage="EXTRACTING_AUDIO",
                stage_progress=10,
                error=missing_source_error,
                user_message="Source media di object storage tidak ditemukan. Import source perlu diperiksa ulang.",
                metadata={
                    "media_asset_id": plan.media_asset_id,
                    "object_key": plan.object_key,
                    "output_audio_path": plan.output_audio_path,
                },
            )
            raise missing_source_error
        extraction_error = RuntimeError(message)
        await emit_retry_warning(
            job_id=plan.job_id,
            stage="EXTRACTING_AUDIO",
            stage_progress=10,
            error=extraction_error,
            user_message="Audio extraction gagal di worker dan akan dicoba ulang otomatis.",
            metadata={
                "media_asset_id": plan.media_asset_id,
                "output_audio_path": plan.output_audio_path,
            },
        )
        raise extraction_error

    if not output_audio_path.exists():
        missing_output_error = RuntimeError("ffmpeg completed without creating the extracted audio file")
        await emit_retry_warning(
            job_id=plan.job_id,
            stage="EXTRACTING_AUDIO",
            stage_progress=10,
            error=missing_output_error,
            user_message="Audio extraction tidak menghasilkan file output dan akan dicoba ulang otomatis.",
            metadata={
                "media_asset_id": plan.media_asset_id,
                "output_audio_path": plan.output_audio_path,
            },
        )
        raise missing_output_error

    result = AudioExtractionResult(
        media_asset_id=plan.media_asset_id,
        output_audio_path=plan.output_audio_path,
        sample_rate=plan.sample_rate,
        command=plan.command,
    )
    activity.heartbeat(
        {
            "media_asset_id": plan.media_asset_id,
            "output_audio_path": plan.output_audio_path,
            "sample_rate": plan.sample_rate,
        }
    )
    return result.model_dump(mode="json")


async def _communicate_with_heartbeat(
    process: asyncio.subprocess.Process,
    *,
    plan: AudioExtractionPlan,
    timeout_seconds: float,
) -> tuple[bytes, bytes]:
    communicate_task = asyncio.create_task(process.communicate())
    started_at = monotonic()
    heartbeat_interval_seconds = 5.0

    while True:
        elapsed_seconds = monotonic() - started_at
        remaining_seconds = timeout_seconds - elapsed_seconds
        if remaining_seconds <= 0:
            communicate_task.cancel()
            with suppress(asyncio.CancelledError):
                await communicate_task
            raise asyncio.TimeoutError

        try:
            stdout, stderr = await asyncio.wait_for(
                asyncio.shield(communicate_task),
                timeout=min(heartbeat_interval_seconds, remaining_seconds),
            )
            activity.heartbeat(
                {
                    "media_asset_id": plan.media_asset_id,
                    "output_audio_path": plan.output_audio_path,
                    "sample_rate": plan.sample_rate,
                    "elapsed_seconds": round(monotonic() - started_at, 2),
                    "completed": True,
                }
            )
            return stdout, stderr
        except asyncio.TimeoutError:
            activity.heartbeat(
                {
                    "media_asset_id": plan.media_asset_id,
                    "output_audio_path": plan.output_audio_path,
                    "sample_rate": plan.sample_rate,
                    "elapsed_seconds": round(monotonic() - started_at, 2),
                    "completed": False,
                }
            )


async def _terminate_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is None:
        process.kill()
    try:
        await asyncio.wait_for(process.communicate(), timeout=10)
    except (asyncio.TimeoutError, ProcessLookupError):
        pass


async def _source_object_exists(download_url: str) -> bool:
    async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
        response = await client.get(
            download_url,
            headers={"range": "bytes=0-0"},
        )
        return response.status_code < 400
