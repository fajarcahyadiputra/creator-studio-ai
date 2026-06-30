from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from temporalio import activity
from temporalio.exceptions import ApplicationError

from app.config import get_settings
from app.domain.contracts import (
    AudioExtractionResult,
    TranscriptDocument,
    TranscriptionPersistenceRequest,
    TranscriptSegment,
    TranscriptWord,
    TranscriptionPlan,
    TranscriptionResult,
)
from app.infrastructure.media_asset_client import MediaAssetClient


@activity.defn
async def prepare_transcription(payload: dict[str, Any]) -> dict[str, Any]:
    extraction = AudioExtractionResult.model_validate(payload)
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
    settings = get_settings()

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
    )
    transcript = build_transcript_document(
        language=(info.language or plan.language_hint or "und"),
        segments=list(segments),
    )

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
        words = [
            TranscriptWord(
                start_seconds=float(getattr(word, "start")),
                end_seconds=float(getattr(word, "end")),
                text=str(getattr(word, "word")).strip(),
                confidence=float(probability) if (probability := getattr(word, "probability", None)) is not None else None,
            )
            for word in (getattr(segment, "words", None) or [])
            if str(getattr(word, "word", "")).strip()
        ]

        transcript_segments.append(
            TranscriptSegment(
                segment_id=f"segment-{index:04d}",
                start_seconds=float(getattr(segment, "start")),
                end_seconds=float(getattr(segment, "end")),
                text=str(getattr(segment, "text")).strip(),
                speaker_label=None,
                confidence=float(probability)
                if (probability := getattr(segment, "avg_logprob", None)) is not None
                else None,
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
