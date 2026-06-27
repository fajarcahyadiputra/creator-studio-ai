from typing import Any

from temporalio import activity
from temporalio.exceptions import ApplicationError

from app.application.phase2_candidate_analyzer import analyze_phase2_candidates_with_fallback
from app.domain.contracts import AnalysisInputs


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
    activity.heartbeat({"stage": "TRANSCRIBING", "segment_count": len(parsed.transcript.segments)})
    return parsed.model_dump(mode="json")


@activity.defn
async def analyze_phase2_candidates(payload: dict[str, Any]) -> dict[str, Any]:
    input_snapshot = payload.get("input_snapshot")
    analysis_inputs_raw = payload.get("analysis_inputs")
    if not isinstance(input_snapshot, dict) or not isinstance(analysis_inputs_raw, dict):
        raise ApplicationError("analysis inputs are required", non_retryable=True, type="InvalidInput")
    analysis_inputs = AnalysisInputs.model_validate(analysis_inputs_raw)
    summary = await analyze_phase2_candidates_with_fallback(
        analysis_inputs=analysis_inputs,
        input_snapshot=input_snapshot,
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
    return summary
