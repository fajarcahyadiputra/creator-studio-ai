from __future__ import annotations

import asyncio
import json
import math
from contextlib import suppress
from pathlib import Path
from time import monotonic
from typing import Any

from temporalio import activity
from temporalio.exceptions import ApplicationError

from app.config import get_settings
from app.activities.warning_events import emit_retry_warning
from app.domain.contracts import (
    AudioExtractionResult,
    ProgressEvent,
    TranscriptDocument,
    TranscriptionPersistenceRequest,
    TranscriptSegment,
    TranscriptWord,
    TranscriptionPlan,
    TranscriptionResult,
)
from app.domain.auto_clip_stages import compute_overall_progress
from app.infrastructure.callback_client import JobCallbackClient
from app.infrastructure.media_asset_client import MediaAssetClient


@activity.defn
async def prepare_transcription(payload: dict[str, Any]) -> dict[str, Any]:
    extraction = AudioExtractionResult.model_validate(
        {
            key: payload.get(key)
            for key in (
                "media_asset_id",
                "output_audio_path",
                "sample_rate",
                "command",
            )
        }
    )
    input_snapshot = payload.get("input_snapshot")
    audio_path = Path(extraction.output_audio_path)
    output_transcript_path = audio_path.with_name("transcript.json")
    language_hint, custom_vocabulary = _resolve_transcription_hints(input_snapshot)

    plan = TranscriptionPlan(
        media_asset_id=extraction.media_asset_id,
        job_id=str(payload["job_id"]) if isinstance(payload.get("job_id"), str) else None,
        user_id=_resolve_user_id(audio_path),
        audio_path=str(audio_path),
        output_transcript_path=str(output_transcript_path),
        language_hint=language_hint,
        custom_vocabulary=custom_vocabulary,
    )
    activity.heartbeat(
        {
            "media_asset_id": extraction.media_asset_id,
            "job_id": plan.job_id,
            "audio_path": extraction.output_audio_path,
            "output_transcript_path": str(output_transcript_path),
            "language_hint": language_hint,
        }
    )
    return plan.model_dump(mode="json")


@activity.defn
async def execute_transcription(payload: dict[str, Any]) -> dict[str, Any]:
    plan = TranscriptionPlan.model_validate(payload)
    existing_transcript = _load_existing_transcript(Path(plan.output_transcript_path))
    if existing_transcript is not None:
        activity.heartbeat(
            {
                "media_asset_id": plan.media_asset_id,
                "segment_count": len(existing_transcript.segments),
                "language": existing_transcript.language,
                "cached_transcript": True,
            }
        )
        return json.loads(
            TranscriptionResult(
                media_asset_id=plan.media_asset_id,
                job_id=plan.job_id,
                output_transcript_path=plan.output_transcript_path,
                transcript=existing_transcript,
            ).model_dump_json()
        )

    settings = get_settings()
    transcription_task = asyncio.create_task(asyncio.to_thread(_transcribe_sync, plan, settings))
    started_at = monotonic()
    heartbeat_interval_seconds = max(1.0, min(10.0, float(settings.TRANSCRIPTION_TIMEOUT_SECONDS)))
    progress_emit_interval_seconds = max(15, int(min(60, heartbeat_interval_seconds * 3)))
    last_progress_emit_at = started_at

    try:
        while True:
            try:
                transcript = await asyncio.wait_for(
                    asyncio.shield(transcription_task),
                    timeout=heartbeat_interval_seconds,
                )
                break
            except asyncio.TimeoutError:
                elapsed_seconds = int(monotonic() - started_at)
                if elapsed_seconds >= int(settings.TRANSCRIPTION_TIMEOUT_SECONDS):
                    timeout_error = TimeoutError(
                        f"transcription exceeded {int(settings.TRANSCRIPTION_TIMEOUT_SECONDS)} seconds"
                    )
                    transcription_task.cancel()
                    with suppress(Exception):
                        await transcription_task
                    await emit_retry_warning(
                        job_id=plan.job_id,
                        stage="TRANSCRIBING",
                        stage_progress=10,
                        error=timeout_error,
                        user_message="Transcription terlalu lama dan akan dicoba ulang otomatis.",
                        metadata={
                            "elapsed_seconds": elapsed_seconds,
                            "media_asset_id": plan.media_asset_id,
                            "language_hint": plan.language_hint,
                            "timeout_seconds": int(settings.TRANSCRIPTION_TIMEOUT_SECONDS),
                        },
                    )
                    raise timeout_error

                activity.heartbeat(
                    {
                        "media_asset_id": plan.media_asset_id,
                        "stage": "TRANSCRIBING",
                        "elapsed_seconds": elapsed_seconds,
                        "language_hint": plan.language_hint,
                    }
                )
                if monotonic() - last_progress_emit_at >= progress_emit_interval_seconds:
                    await _emit_transcription_progress(plan, elapsed_seconds, int(settings.TRANSCRIPTION_TIMEOUT_SECONDS))
                    last_progress_emit_at = monotonic()
    except Exception as error:
        if isinstance(error, TimeoutError) and str(error).startswith("transcription exceeded"):
            raise
        await emit_retry_warning(
            job_id=plan.job_id,
            stage="TRANSCRIBING",
            stage_progress=10,
            error=error,
            user_message="Transcription mengalami error worker dan akan dicoba ulang otomatis.",
            metadata={
                "elapsed_seconds": int(monotonic() - started_at),
                "media_asset_id": plan.media_asset_id,
                "language_hint": plan.language_hint,
            },
        )
        raise
    except asyncio.CancelledError:
        transcription_task.cancel()
        with suppress(Exception):
            await transcription_task
        raise

    output_path = Path(plan.output_transcript_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        transcript.model_dump_json(indent=2),
        encoding="utf-8",
    )

    result = TranscriptionResult(
        media_asset_id=plan.media_asset_id,
        job_id=plan.job_id,
        output_transcript_path=plan.output_transcript_path,
        transcript=transcript,
    )
    activity.heartbeat(
        {
            "media_asset_id": plan.media_asset_id,
            "segment_count": len(transcript.segments),
            "language": transcript.language,
        }
    )
    return json.loads(result.model_dump_json())


def _transcribe_sync(plan: TranscriptionPlan, settings: Any) -> TranscriptDocument:
    try:
        from faster_whisper import WhisperModel
    except ImportError as error:
        raise ApplicationError(
            "faster-whisper is not installed in this worker environment",
            non_retryable=True,
            type="DependencyMissing",
        ) from error

    model = WhisperModel(
        settings.FASTER_WHISPER_MODEL_SIZE,
        device=settings.FASTER_WHISPER_DEVICE,
        compute_type=settings.FASTER_WHISPER_COMPUTE_TYPE,
    )
    segments, info = model.transcribe(
        plan.audio_path,
        language=plan.language_hint,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={
            "min_silence_duration_ms": 350,
            "speech_pad_ms": 180,
        },
    )
    return build_transcript_document(
        language=(info.language or plan.language_hint or "und"),
        segments=list(segments),
    )


@activity.defn
async def submit_transcription_result(payload: dict[str, Any]) -> None:
    result = TranscriptionResult.model_validate(payload)
    settings = get_settings()
    request = TranscriptionPersistenceRequest(
        media_asset_id=result.media_asset_id,
        job_id=result.job_id,
        output_transcript_path=result.output_transcript_path,
        model_identifier=f"faster-whisper:{settings.FASTER_WHISPER_MODEL_SIZE}",
        word_timestamps=True,
        transcript=result.transcript,
    )
    await MediaAssetClient().submit_transcription_result(result.media_asset_id, request)
    activity.heartbeat(
        {
            "media_asset_id": result.media_asset_id,
            "segment_count": len(result.transcript.segments),
            "language": result.transcript.language,
        }
    )


def build_transcript_document(language: str, segments: list[Any]) -> TranscriptDocument:
    transcript_segments: list[TranscriptSegment] = []

    for index, segment in enumerate(segments, start=1):
        segment_start = _normalize_timestamp(getattr(segment, "start", None))
        segment_end = _normalize_timestamp(getattr(segment, "end", None))
        segment_text = str(getattr(segment, "text", "")).strip()
        if segment_start is None or segment_end is None or segment_end <= segment_start or not segment_text:
            continue

        words: list[TranscriptWord] = []
        for word in (getattr(segment, "words", None) or []):
            word_text = str(getattr(word, "word", "")).strip()
            word_start = _normalize_timestamp(getattr(word, "start", None))
            word_end = _normalize_timestamp(getattr(word, "end", None))
            if not word_text or word_start is None or word_end is None or word_end <= word_start:
                continue

            words.append(
                TranscriptWord(
                    start_seconds=word_start,
                    end_seconds=word_end,
                    text=word_text,
                    confidence=_normalize_probability(getattr(word, "probability", None)),
                )
            )

        transcript_segments.append(
            TranscriptSegment(
                segment_id=f"segment-{index:04d}",
                start_seconds=segment_start,
                end_seconds=segment_end,
                text=segment_text,
                speaker_label=None,
                confidence=_normalize_log_probability(getattr(segment, "avg_logprob", None)),
                words=words,
            )
        )

    if not transcript_segments:
        raise ValueError("transcription produced no segments")

    duration_seconds = transcript_segments[-1].end_seconds if transcript_segments else 0.0
    return TranscriptDocument(
        language=language,
        duration_seconds=duration_seconds,
        segments=transcript_segments,
    )


def _resolve_user_id(audio_path: Path) -> str:
    parts = audio_path.parts
    if len(parts) >= 3:
        return parts[-3]
    return "unknown-user"


def _resolve_transcription_hints(input_snapshot: Any) -> tuple[str | None, list[str]]:
    if not isinstance(input_snapshot, dict):
        return (None, [])

    content = input_snapshot.get("content")
    if not isinstance(content, dict):
        return (None, [])

    language_hint = content.get("source_language")
    resolved_language_hint = language_hint if isinstance(language_hint, str) and language_hint else None

    raw_vocabulary = content.get("custom_vocabulary")
    if not isinstance(raw_vocabulary, list):
        return (resolved_language_hint, [])

    custom_vocabulary = [value.strip() for value in raw_vocabulary if isinstance(value, str) and value.strip()]
    return (resolved_language_hint, custom_vocabulary[:200])


def _normalize_probability(value: Any) -> float | None:
    if value is None:
        return None
    try:
        probability = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(probability) or math.isinf(probability):
        return None
    return max(0.0, min(1.0, probability))


def _normalize_log_probability(value: Any) -> float | None:
    if value is None:
        return None
    try:
        log_probability = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(log_probability) or math.isinf(log_probability):
        return None
    return max(0.0, min(1.0, math.exp(log_probability)))


def _normalize_timestamp(value: Any) -> float | None:
    try:
        timestamp = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(timestamp) or math.isinf(timestamp) or timestamp < 0:
        return None
    return timestamp


def _load_existing_transcript(path: Path) -> TranscriptDocument | None:
    if not path.exists() or not path.is_file():
        return None
    try:
        return TranscriptDocument.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


async def _emit_transcription_progress(
    plan: TranscriptionPlan,
    elapsed_seconds: int,
    timeout_seconds: int,
) -> None:
    if not plan.job_id:
        return

    bounded_timeout_seconds = max(60, timeout_seconds)
    ratio = min(0.95, max(0.0, elapsed_seconds / bounded_timeout_seconds))
    stage_progress = max(12, min(95, round(10 + ratio * 80)))
    event = ProgressEvent(
        stage="TRANSCRIBING",
        stage_progress=stage_progress,
        overall_progress=compute_overall_progress("TRANSCRIBING", stage_progress),
        event_type="job.progress",
        message=(
            f"Transcription still running after {elapsed_seconds} seconds "
            f"for media asset {plan.media_asset_id}."
        ),
        user_message=(
            f"Transkripsi masih berjalan selama sekitar {elapsed_seconds} detik. "
            "Audio panjang masih sedang diproses."
        ),
        metadata={
            "media_asset_id": plan.media_asset_id,
            "elapsed_seconds": elapsed_seconds,
            "language_hint": plan.language_hint,
            "timeout_seconds": bounded_timeout_seconds,
        },
        status="RUNNING",
    )
    with suppress(Exception):
        await JobCallbackClient().send(plan.job_id, event)
