from __future__ import annotations

from pathlib import Path
from typing import Any

from temporalio import activity
from temporalio.exceptions import ApplicationError

from app.config import get_settings
from app.domain.contracts import AudioExtractionPlan, AudioExtractionResult, MediaAssetValidationContext
from app.media.ffmpeg import build_audio_extraction
import asyncio


@activity.defn
async def prepare_audio_extraction(payload: dict[str, Any]) -> dict[str, Any]:
    context = MediaAssetValidationContext.model_validate(payload)
    if context.status != "READY":
        raise ApplicationError(
            "media asset must be READY before audio extraction planning",
            non_retryable=True,
            type="InvalidInput",
        )

    settings = get_settings()
    working_directory = Path(settings.TEMP_WORKDIR) / context.user_id / context.media_asset_id
    output_audio_path = working_directory / "audio.wav"
    command = build_audio_extraction(Path(str(context.download_url)), output_audio_path, sample_rate=16_000)

    plan = AudioExtractionPlan(
        media_asset_id=context.media_asset_id,
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
        _stdout, stderr = await asyncio.wait_for(
            process.communicate(),
            timeout=settings.AUDIO_EXTRACTION_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        process.kill()
        await process.communicate()
        raise TimeoutError("ffmpeg audio extraction timed out")

    if process.returncode != 0:
        message = stderr.decode("utf-8", errors="replace").strip() or "ffmpeg exited with a non-zero status"
        raise RuntimeError(message)

    if not output_audio_path.exists():
        raise RuntimeError("ffmpeg completed without creating the extracted audio file")

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
