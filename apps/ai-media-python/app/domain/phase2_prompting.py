from typing import Any

from app.domain.contracts import AnalysisInputs

AUTO_CLIP_ANALYZER_PROMPT_VERSION = "phase2-candidate-analyzer-v1"


def build_candidate_analyzer_system_prompt() -> str:
    return (
        "You are a structured short-form video clip analyst. "
        "Return only schema-valid JSON. "
        "Preserve factual grounding in the transcript. "
        "Do not invent speakers, scenes, or claims that are not supported by the input. "
        "Prefer clips with a strong hook, coherent context, clean ending, and audience-response potential. "
        "Keep safety notes concise and include them only when needed."
    )


def build_candidate_analyzer_payload(
    analysis_inputs: AnalysisInputs,
    input_snapshot: dict[str, Any],
) -> dict[str, Any]:
    strategy = input_snapshot.get("strategy")
    strategy_payload = strategy if isinstance(strategy, dict) else {}
    transcript = analysis_inputs.transcript
    return {
        "language": transcript.language,
        "duration_seconds": transcript.duration_seconds,
        "strategy": {
            "target_platform": strategy_payload.get("target_platform"),
            "objective": strategy_payload.get("objective"),
            "desired_clip_count": strategy_payload.get("desired_clip_count"),
            "minimum_duration_seconds": strategy_payload.get("minimum_duration_seconds"),
            "maximum_duration_seconds": strategy_payload.get("maximum_duration_seconds"),
            "minimum_viral_score": strategy_payload.get("minimum_viral_score"),
        },
        "transcript_segments": [
            {
                "segment_id": segment.segment_id,
                "start_seconds": segment.start_seconds,
                "end_seconds": segment.end_seconds,
                "speaker_label": segment.speaker_label,
                "text": segment.text,
            }
            for segment in transcript.segments
        ],
        "scenes": [
            {
                "scene_id": scene.scene_id,
                "start_seconds": scene.start_seconds,
                "end_seconds": scene.end_seconds,
            }
            for scene in analysis_inputs.scenes
        ],
        "silences": [
            {
                "silence_id": silence.silence_id,
                "start_seconds": silence.start_seconds,
                "end_seconds": silence.end_seconds,
            }
            for silence in analysis_inputs.silences
        ],
    }
