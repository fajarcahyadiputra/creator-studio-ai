from typing import Any

from temporalio.exceptions import ApplicationError

from app.domain.contracts import AnalysisInputs, FoundationWorkflowInput


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
    return parsed
