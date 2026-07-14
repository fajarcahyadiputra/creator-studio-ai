import asyncio
from typing import Any

from temporalio import activity
from temporalio.exceptions import ApplicationError

from app.activities.warning_events import emit_retry_warning
from app.config import get_settings
from app.application.phase2_candidate_analyzer import analyze_phase2_candidates_with_fallback
from app.domain.boundary_detection import enrich_analysis_inputs as enrich_boundary_inputs
from app.domain.contracts import AnalysisInputs, SceneBoundary, SilenceBoundary, TranscriptSegment, TranscriptionResult

MAX_TRANSCRIPT_SEGMENTS = 180
MAX_SEGMENT_TEXT_CHARS = 280
MAX_MERGED_SEGMENT_DURATION_SECONDS = 18.0
MAX_MERGED_SEGMENT_GAP_SECONDS = 0.85
MAX_SCENES = 240
MAX_SILENCES = 240


@activity.defn
async def prepare_analysis_inputs(payload: dict[str, Any]) -> dict[str, Any]:
    input_snapshot = payload.get("input_snapshot")
    if not isinstance(input_snapshot, dict):
        raise ApplicationError("input_snapshot is required", non_retryable=True, type="InvalidInput")
    analysis_inputs = input_snapshot.get("analysis_inputs")
    if analysis_inputs is None:
        raise ApplicationError(
            "Phase 2 analysis inputs are required for the MVP analysis pipeline.",
            non_retryable=True,
            type="Phase2InputMissing",
        )
    parsed = AnalysisInputs.model_validate(analysis_inputs)
    parsed = _prune_analysis_inputs_for_candidate_stage(parsed)
    activity.heartbeat({"stage": "TRANSCRIBING", "segment_count": len(parsed.transcript.segments)})
    return parsed.model_dump(mode="json")


@activity.defn
async def prepare_analysis_inputs_from_transcript(payload: dict[str, Any]) -> dict[str, Any]:
    transcription = TranscriptionResult.model_validate(payload)
    analysis_inputs = AnalysisInputs(
        transcript=transcription.transcript,
        scenes=[],
        silences=[],
    )
    analysis_inputs = _prune_analysis_inputs_for_candidate_stage(analysis_inputs)
    activity.heartbeat(
        {
            "stage": "TRANSCRIBING",
            "media_asset_id": transcription.media_asset_id,
            "segment_count": len(transcription.transcript.segments),
        }
    )
    return analysis_inputs.model_dump(mode="json")


@activity.defn
async def enrich_analysis_inputs(payload: dict[str, Any]) -> dict[str, Any]:
    input_snapshot = payload.get("input_snapshot")
    analysis_inputs_raw = payload.get("analysis_inputs")
    if not isinstance(input_snapshot, dict) or not isinstance(analysis_inputs_raw, dict):
        raise ApplicationError("analysis inputs are required", non_retryable=True, type="InvalidInput")

    parsed = AnalysisInputs.model_validate(analysis_inputs_raw)
    strategy = input_snapshot.get("strategy")
    strategy_payload = strategy if isinstance(strategy, dict) else {}
    max_scene_duration_seconds = float(strategy_payload.get("maximum_duration_seconds", 12))
    min_silence_gap_seconds = 0.45 if strategy_payload.get("remove_long_silence", True) else 0.75
    enriched = enrich_boundary_inputs(
        parsed,
        max_scene_duration_seconds=max(6.0, min(max_scene_duration_seconds / 2, 20.0)),
        min_silence_gap_seconds=min_silence_gap_seconds,
    )
    enriched = _prune_analysis_inputs_for_candidate_stage(enriched)
    activity.heartbeat(
        {
            "stage": "DETECTING_SCENES",
            "scene_count": len(enriched.scenes),
            "silence_count": len(enriched.silences),
        }
    )
    return enriched.model_dump(mode="json")


@activity.defn
async def analyze_phase2_candidates(payload: dict[str, Any]) -> dict[str, Any]:
    input_snapshot = payload.get("input_snapshot")
    analysis_inputs_raw = payload.get("analysis_inputs")
    job_id = str(payload["job_id"]) if isinstance(payload.get("job_id"), str) else None
    if not isinstance(input_snapshot, dict) or not isinstance(analysis_inputs_raw, dict):
        raise ApplicationError("analysis inputs are required", non_retryable=True, type="InvalidInput")
    analysis_inputs = AnalysisInputs.model_validate(analysis_inputs_raw)
    settings = get_settings()
    ai_snapshot = input_snapshot.get("ai") if isinstance(input_snapshot.get("ai"), dict) else {}
    runtime_snapshot = (
        ai_snapshot.get("analyzer_runtime")
        if isinstance(ai_snapshot.get("analyzer_runtime"), dict)
        else {}
    )
    summary = await _await_with_analysis_heartbeat(
        analyze_phase2_candidates_with_fallback(
            analysis_inputs=analysis_inputs,
            input_snapshot=input_snapshot,
        ),
        heartbeat_interval_seconds=10.0,
        timeout_seconds=float(settings.ANALYZER_TIMEOUT_SECONDS),
        heartbeat_metadata={
            "stage": "ANALYZING_CLIP_CANDIDATES",
            "job_id": job_id,
            "transcript_segment_count": len(analysis_inputs.transcript.segments),
            "scene_count": len(analysis_inputs.scenes),
            "silence_count": len(analysis_inputs.silences),
            "configured_mode": runtime_snapshot.get("mode"),
            "configured_provider": runtime_snapshot.get("provider"),
            "configured_model": runtime_snapshot.get("model"),
        },
    )
    activity.heartbeat(
        {
            "stage": "ANALYZING_CLIP_CANDIDATES",
            "candidate_count": int(summary["candidate_count"]),
            "analysis_version": summary.get("analysis_version"),
            "analysis_mode": (
                summary.get("analyzer", {}).get("analysis_mode")
                if isinstance(summary.get("analyzer"), dict)
                else None
            ),
        }
    )

    analyzer = summary.get("analyzer")
    fallback_reason = (
        analyzer.get("fallback_reason")
        if isinstance(analyzer, dict)
        else None
    )
    if isinstance(fallback_reason, str) and fallback_reason:
        await emit_retry_warning(
            job_id=job_id,
            stage="ANALYZING_CLIP_CANDIDATES",
            stage_progress=90,
            error=RuntimeError(f"OpenAI analyzer fallback triggered: {fallback_reason}"),
            user_message="Analyzer AI sempat gagal, lalu workflow memakai heuristic fallback agar job tetap selesai.",
            metadata={
                "fallback_reason": fallback_reason,
                "candidate_count": int(summary["candidate_count"]),
                "analysis_version": summary.get("analysis_version"),
                "analysis_mode": (
                    analyzer.get("analysis_mode")
                    if isinstance(analyzer, dict)
                    else None
                ),
                "provider": (
                    analyzer.get("provider")
                    if isinstance(analyzer, dict)
                    else None
                ),
                "model": (
                    analyzer.get("model")
                    if isinstance(analyzer, dict)
                    else None
                ),
            },
        )

    return summary


async def _await_with_analysis_heartbeat(
    coroutine: Any,
    *,
    heartbeat_interval_seconds: float,
    timeout_seconds: float,
    heartbeat_metadata: dict[str, Any],
) -> Any:
    task = asyncio.create_task(coroutine)
    elapsed_seconds = 0.0

    try:
        while True:
            try:
                return await asyncio.wait_for(asyncio.shield(task), timeout=heartbeat_interval_seconds)
            except asyncio.TimeoutError:
                elapsed_seconds += heartbeat_interval_seconds
                activity.heartbeat(
                    {
                        **heartbeat_metadata,
                        "elapsed_seconds": round(elapsed_seconds, 1),
                        "timeout_seconds": int(timeout_seconds),
                    }
                )
                if elapsed_seconds >= timeout_seconds:
                    task.cancel()
                    raise TimeoutError("candidate analysis timed out")
    except asyncio.CancelledError:
        if not task.done():
            task.cancel()
        raise


def _prune_analysis_inputs_for_candidate_stage(analysis_inputs: AnalysisInputs) -> AnalysisInputs:
    pruned_segments = _condense_transcript_segments(analysis_inputs.transcript.segments)
    return analysis_inputs.model_copy(
        update={
            "transcript": analysis_inputs.transcript.model_copy(
                update={
                    "segments": pruned_segments
                }
            ),
            "scenes": _limit_boundaries(analysis_inputs.scenes, MAX_SCENES),
            "silences": _limit_boundaries(analysis_inputs.silences, MAX_SILENCES),
        }
    )


def _condense_transcript_segments(segments: list[TranscriptSegment]) -> list[TranscriptSegment]:
    if not segments:
        return []

    condensed: list[TranscriptSegment] = []
    current_group: list[TranscriptSegment] = []

    for segment in segments:
        normalized = segment.model_copy(
            update={
                "text": _truncate_text(segment.text.strip(), MAX_SEGMENT_TEXT_CHARS),
                "words": [],
            }
        )
        if not normalized.text:
            continue

        if not current_group:
            current_group.append(normalized)
            continue

        previous = current_group[-1]
        same_speaker = previous.speaker_label == normalized.speaker_label
        gap_seconds = max(0.0, normalized.start_seconds - previous.end_seconds)
        merged_duration = normalized.end_seconds - current_group[0].start_seconds
        merged_text = " ".join(item.text for item in current_group + [normalized]).strip()

        if (
            same_speaker
            and gap_seconds <= MAX_MERGED_SEGMENT_GAP_SECONDS
            and merged_duration <= MAX_MERGED_SEGMENT_DURATION_SECONDS
            and len(merged_text) <= MAX_SEGMENT_TEXT_CHARS
        ):
            current_group.append(normalized)
            continue

        condensed.append(_merge_segment_group(current_group, len(condensed) + 1))
        current_group = [normalized]

    if current_group:
        condensed.append(_merge_segment_group(current_group, len(condensed) + 1))

    if len(condensed) <= MAX_TRANSCRIPT_SEGMENTS:
        return condensed

    stride = max(1, len(condensed) // MAX_TRANSCRIPT_SEGMENTS)
    sampled = [condensed[index] for index in range(0, len(condensed), stride)]
    return sampled[:MAX_TRANSCRIPT_SEGMENTS]


def _merge_segment_group(group: list[TranscriptSegment], position: int) -> TranscriptSegment:
    if len(group) == 1:
        segment = group[0]
        return segment.model_copy(
            update={
                "segment_id": f"segment-{position:04d}",
                "words": [],
                "text": _truncate_text(segment.text.strip(), MAX_SEGMENT_TEXT_CHARS),
            }
        )

    merged_text = _truncate_text(" ".join(segment.text.strip() for segment in group), MAX_SEGMENT_TEXT_CHARS)
    confidences = [segment.confidence for segment in group if segment.confidence is not None]
    return TranscriptSegment(
        segment_id=f"segment-{position:04d}",
        start_seconds=group[0].start_seconds,
        end_seconds=group[-1].end_seconds,
        text=merged_text,
        speaker_label=group[0].speaker_label,
        confidence=(round(sum(confidences) / len(confidences), 4) if confidences else None),
        words=[],
    )


def _limit_boundaries(
    boundaries: list[SceneBoundary] | list[SilenceBoundary],
    limit: int,
) -> list[SceneBoundary] | list[SilenceBoundary]:
    if len(boundaries) <= limit:
        return boundaries
    stride = max(1, len(boundaries) // limit)
    return [boundary for index, boundary in enumerate(boundaries) if index % stride == 0][:limit]


def _truncate_text(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    truncated = text[: limit - 3].rstrip(" ,;:-")
    return f"{truncated}..."
