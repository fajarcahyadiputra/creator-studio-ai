from typing import Any

from temporalio.exceptions import ApplicationError

from app.domain.contracts import AnalysisInputs, FoundationWorkflowInput, TtsRequestPayload
from app.domain.tts_models import get_local_tts_model


def validate_foundation_input(raw: dict[str, Any]) -> FoundationWorkflowInput:
    parsed = FoundationWorkflowInput.model_validate(raw)
    if parsed.job_type == "AUTO_CLIPPING":
        source = parsed.input_snapshot.get("source")
        content = parsed.input_snapshot.get("content")
        if not isinstance(source, dict):
            raise ApplicationError(
                "Auto clipping source is required",
                non_retryable=True,
                type="InvalidInput",
            )
        if not isinstance(content, dict) or content.get("rights_confirmed") is not True:
            raise ApplicationError(
                "Content rights confirmation is required", non_retryable=True, type="RightsNotConfirmed"
            )
        analysis_inputs = parsed.input_snapshot.get("analysis_inputs")
        if analysis_inputs is not None:
            AnalysisInputs.model_validate(analysis_inputs)
    if parsed.job_type == "TEXT_TO_SPEECH":
        snapshot = parsed.input_snapshot if isinstance(parsed.input_snapshot, dict) else {}
        TtsRequestPayload.model_validate(
            {
                "job_id": parsed.job_id,
                "script": snapshot.get("script"),
                "language": snapshot.get("language", "id"),
                "local_model_key": snapshot.get("local_model_key"),
                "voice_identifier": snapshot.get("voice_identifier"),
                "speaking_style": snapshot.get("speaking_style"),
                "emotion": snapshot.get("emotion"),
                "speaking_speed": snapshot.get("speaking_speed"),
                "pitch": snapshot.get("pitch"),
                "pause_intensity": snapshot.get("pause_intensity"),
                "target_duration_ms": snapshot.get("target_duration_ms"),
                "pronunciation_dictionary": snapshot.get("pronunciation_dictionary") or {},
                "output_config": snapshot.get("output_config") or {},
            }
        )
        local_model_key = snapshot.get("local_model_key")
        if isinstance(local_model_key, str) and local_model_key.strip():
            if get_local_tts_model(local_model_key) is None:
                raise ApplicationError(
                    f"Local TTS model '{local_model_key}' is not available",
                    non_retryable=True,
                    type="InvalidInput",
                )
    return parsed
