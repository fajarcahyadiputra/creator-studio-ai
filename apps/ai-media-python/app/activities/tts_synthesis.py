from __future__ import annotations

import asyncio
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

import httpx
from temporalio import activity
from temporalio.exceptions import ApplicationError

from app.application.local_tts_render import LocalTtsRenderRequest, synthesize_local_tts_document
from app.config import get_settings
from app.domain.contracts import TtsOutputPersistenceRequest, TtsRequestPayload, TtsSpeechSegmentsDocument
from app.infrastructure.media_asset_client import MediaAssetClient
from app.media.ffmpeg import build_audio_transcode


@activity.defn
async def execute_tts_audio_synthesis(payload: dict[str, Any]) -> dict[str, Any]:
    job_id = payload.get("job_id")
    input_snapshot = payload.get("input_snapshot")
    document_payload = payload.get("document")
    metadata_payload = payload.get("metadata")
    if not isinstance(job_id, str) or not isinstance(input_snapshot, dict) or not isinstance(document_payload, dict):
        raise ApplicationError(
            "job_id, input_snapshot, and document are required",
            non_retryable=True,
            type="InvalidInput",
        )

    request = TtsRequestPayload.model_validate(
        {
            "job_id": job_id,
            "script": input_snapshot.get("script"),
            "language": input_snapshot.get("language", "id"),
            "local_model_key": input_snapshot.get("local_model_key"),
            "voice_identifier": input_snapshot.get("voice_identifier"),
            "speaking_style": input_snapshot.get("speaking_style"),
            "emotion": input_snapshot.get("emotion"),
            "speaking_speed": input_snapshot.get("speaking_speed"),
            "pitch": input_snapshot.get("pitch"),
            "pause_intensity": input_snapshot.get("pause_intensity"),
            "target_duration_ms": input_snapshot.get("target_duration_ms"),
            "pronunciation_dictionary": input_snapshot.get("pronunciation_dictionary") or {},
            "output_config": input_snapshot.get("output_config") or {},
        }
    )
    if not request.local_model_key:
        raise ApplicationError(
            "local_model_key is required for local TTS synthesis",
            non_retryable=True,
            type="InvalidInput",
        )

    document = TtsSpeechSegmentsDocument.model_validate(document_payload)
    render_result = synthesize_local_tts_document(
        LocalTtsRenderRequest(
            model_key=request.local_model_key,
            document=document,
            speaking_speed=request.speaking_speed,
        )
    )
    preferred_format = _resolve_preferred_format(request.output_config)
    target_sample_rate = _resolve_target_sample_rate(request.output_config)
    target_channels = _resolve_target_channels(request.output_config)
    output_audio = await _build_output_audio(
        wav_audio_bytes=render_result.audio_bytes,
        preferred_format=preferred_format,
        sample_rate=target_sample_rate,
        channels=target_channels,
    )
    activity.heartbeat(
        {
            "job_id": job_id,
            "segment_count": render_result.segment_count,
            "duration_ms": render_result.duration_ms,
            "phase": "synthesized",
        }
    )

    media_asset_client = MediaAssetClient()
    target = await media_asset_client.create_tts_output_target(job_id, output_audio["format"])

    async with httpx.AsyncClient(timeout=120.0) as client:
        upload_response = await client.put(
            str(target.upload_url),
            content=output_audio["audio_bytes"],
            headers={"content-type": target.mime_type},
        )
        upload_response.raise_for_status()

    provider_metadata = {
        "provider": "local-piper",
        "renderer": "piper-tts",
        "model_key": request.local_model_key,
        "language": request.language,
        "requested_format": preferred_format,
        "format": output_audio["format"],
        "segment_count": render_result.segment_count,
        "prompt_version": (
            metadata_payload.get("prompt_version")
            if isinstance(metadata_payload, dict) and isinstance(metadata_payload.get("prompt_version"), str)
            else None
        ),
        "speaking_speed_requested": request.speaking_speed,
        "pause_strategy": "append-silence",
        "breath_effects_applied": False,
        "fade_effects_applied": False,
        "fallback_used": output_audio["fallback_used"],
        "fallback_reason": output_audio["fallback_reason"],
    }
    await media_asset_client.submit_tts_output_result(
        job_id,
        TtsOutputPersistenceRequest(
            status="READY",
            object_key=target.object_key,
            mime_type=target.mime_type,
            extension=target.extension,
            duration_ms=str(render_result.duration_ms),
            size_bytes=str(len(output_audio["audio_bytes"])),
            sample_rate=output_audio["sample_rate"],
            channels=output_audio["channels"],
            provider_metadata=provider_metadata,
        ),
    )

    activity.heartbeat(
        {
            "job_id": job_id,
            "segment_count": render_result.segment_count,
            "duration_ms": render_result.duration_ms,
            "phase": "uploaded",
        }
    )
    return {
        "job_id": job_id,
        "status": "READY",
        "object_key": target.object_key,
        "duration_ms": render_result.duration_ms,
        "sample_rate": output_audio["sample_rate"],
        "channels": output_audio["channels"],
        "segment_count": render_result.segment_count,
        "format": output_audio["format"],
    }


async def _build_output_audio(
    *,
    wav_audio_bytes: bytes,
    preferred_format: str,
    sample_rate: int | None,
    channels: int | None,
) -> dict[str, Any]:
    wav_sample_rate = _read_sample_rate_from_wav(wav_audio_bytes)
    wav_channels = _read_channel_count_from_wav(wav_audio_bytes)
    if preferred_format == "wav" and sample_rate is None and channels is None:
        return {
            "audio_bytes": wav_audio_bytes,
            "sample_rate": wav_sample_rate,
            "channels": wav_channels,
            "format": "wav",
            "fallback_used": False,
            "fallback_reason": None,
        }

    try:
        final_audio_bytes = await _transcode_audio(
            wav_audio_bytes=wav_audio_bytes,
            preferred_format=preferred_format,
            sample_rate=sample_rate,
            channels=channels,
        )
        return {
            "audio_bytes": final_audio_bytes,
            "sample_rate": sample_rate if sample_rate is not None else wav_sample_rate,
            "channels": channels if channels is not None else wav_channels,
            "format": preferred_format,
            "fallback_used": False,
            "fallback_reason": None,
        }
    except Exception as exc:
        if preferred_format == "wav":
            raise
        fallback_audio_bytes = wav_audio_bytes
        if sample_rate is not None or channels is not None:
            fallback_audio_bytes = await _transcode_audio(
                wav_audio_bytes=wav_audio_bytes,
                preferred_format="wav",
                sample_rate=sample_rate,
                channels=channels,
            )
        return {
            "audio_bytes": fallback_audio_bytes,
            "sample_rate": sample_rate if sample_rate is not None else wav_sample_rate,
            "channels": channels if channels is not None else wav_channels,
            "format": "wav",
            "fallback_used": True,
            "fallback_reason": str(exc),
        }


async def _transcode_audio(
    *,
    wav_audio_bytes: bytes,
    preferred_format: str,
    sample_rate: int | None,
    channels: int | None,
) -> bytes:
    settings = get_settings()
    with TemporaryDirectory(prefix="tts-output-") as tmpdir:
        temp_dir = Path(tmpdir)
        source_path = temp_dir / "source.wav"
        destination_path = temp_dir / f"output.{preferred_format}"
        source_path.write_bytes(wav_audio_bytes)

        command = build_audio_transcode(
            source=source_path,
            destination=destination_path,
            format=preferred_format,
            sample_rate=sample_rate,
            channels=channels,
        )
        process = await asyncio.create_subprocess_exec(
            *command.as_exec_args(),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=settings.TTS_TRANSCODE_TIMEOUT_SECONDS,
            )
        except TimeoutError as exc:
            process.kill()
            await process.communicate()
            raise RuntimeError("ffmpeg TTS transcode timed out") from exc

        if process.returncode != 0:
            message = stderr.decode("utf-8", errors="replace").strip() or "ffmpeg audio transcode failed"
            raise RuntimeError(message)
        if not destination_path.is_file():
            raise RuntimeError("ffmpeg completed without creating the final TTS audio output")

        return destination_path.read_bytes()


def _resolve_preferred_format(output_config: dict[str, Any]) -> str:
    value = output_config.get("preferred_format")
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"wav", "mp3", "ogg"}:
            return normalized
    return "wav"


def _resolve_target_sample_rate(output_config: dict[str, Any]) -> int | None:
    value = output_config.get("sample_rate")
    return value if isinstance(value, int) and value > 0 else None


def _resolve_target_channels(output_config: dict[str, Any]) -> int | None:
    value = output_config.get("channels")
    return value if isinstance(value, int) and value > 0 else None


def _read_sample_rate_from_wav(wav_audio_bytes: bytes) -> int:
    import io
    import wave

    with wave.open(io.BytesIO(wav_audio_bytes), "rb") as wav_file:
        return wav_file.getframerate()


def _read_channel_count_from_wav(wav_audio_bytes: bytes) -> int:
    import io
    import wave

    with wave.open(io.BytesIO(wav_audio_bytes), "rb") as wav_file:
        return wav_file.getnchannels()
