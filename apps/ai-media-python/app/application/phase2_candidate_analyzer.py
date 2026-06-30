import logging
import json
from pathlib import Path
from time import perf_counter
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field

from app.config import get_settings
from app.domain.auto_clip_pipeline import (
    build_candidate_analyses,
    build_output_summary,
    build_pipeline_config,
    deduplicate_and_rank,
    normalize_candidates,
    PipelineConfig,
)
from app.domain.contracts import AnalysisInputs, CandidateAnalysis
from app.domain.phase2_prompting import (
    AUTO_CLIP_ANALYZER_PROMPT_VERSION,
    build_candidate_analyzer_payload,
    build_candidate_analyzer_system_prompt,
)
from app.providers.base import ProviderRequestContext, StructuredOutputProvider
from app.providers.openai_structured import OpenAIStructuredOutputProvider

logger = logging.getLogger(__name__)


class CandidateBatchOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    analysis_version: str = Field(min_length=1, max_length=40)
    source_summary: str = Field(min_length=1, max_length=2000)
    candidate_count: int = Field(ge=0, le=30)
    candidates: list[CandidateAnalysis] = Field(default_factory=list, max_length=30)


async def analyze_phase2_candidates_with_fallback(
    *,
    analysis_inputs: AnalysisInputs,
    input_snapshot: dict[str, Any],
    provider: StructuredOutputProvider | None = None,
) -> dict[str, Any]:
    settings = get_settings()
    request_id = str(uuid4())
    started = perf_counter()
    config = build_pipeline_config(input_snapshot)
    prompt_payload = build_candidate_analyzer_payload(analysis_inputs, input_snapshot)
    system_prompt = build_candidate_analyzer_system_prompt()

    provider_code = settings.AUTO_CLIP_ANALYZER_PROVIDER or "openai"
    model_identifier = settings.AUTO_CLIP_ANALYZER_MODEL or "gpt-5.5"
    analysis_mode = settings.AUTO_CLIP_ANALYZER_MODE.lower()

    usage: dict[str, Any] | None = None
    provider_request_id: str | None = None
    fallback_reason: str | None = None

    if analysis_mode == "openai":
        try:
            selected_provider = provider or _resolve_provider(provider_code)
            provider_result = await selected_provider.generate_structured(
                context=ProviderRequestContext(
                    provider_code=provider_code,
                    model_identifier=model_identifier,
                    credential_reference="env:OPENAI_API_KEY",
                    request_id=request_id,
                ),
                system_prompt=system_prompt,
                input_payload=prompt_payload,
                schema=load_clip_analyzer_schema(),
            )
            batch = CandidateBatchOutput.model_validate(provider_result["output"])
            candidates = _limit_and_score_candidates(batch.candidates, analysis_inputs, config)
            summary = build_output_summary(candidates, source_summary=batch.source_summary)
            usage = provider_result.get("usage") if isinstance(provider_result.get("usage"), dict) else None
            provider_request_id = (
                str(provider_result.get("provider_request_id"))
                if provider_result.get("provider_request_id") is not None
                else None
            )
            return _finalize_summary(
                summary=summary,
                analysis_mode="openai",
                prompt_version=AUTO_CLIP_ANALYZER_PROMPT_VERSION,
                provider=provider_code,
                model=model_identifier,
                request_id=request_id,
                provider_request_id=provider_request_id,
                usage=usage,
                latency_ms=round((perf_counter() - started) * 1000, 2),
                analysis_inputs=analysis_inputs,
                fallback_reason=None,
            )
        except Exception as error:
            fallback_reason = type(error).__name__
            logger.warning(
                "OpenAI phase2 analyzer failed; falling back to heuristic scoring",
                extra={
                    "request_id": request_id,
                    "provider": provider_code,
                    "model": model_identifier,
                    "error_type": type(error).__name__,
                },
            )

    candidates = build_candidate_analyses(analysis_inputs, config)
    summary = build_output_summary(candidates)
    provider_name = provider_code if analysis_mode == "openai" else None
    model_name = model_identifier if analysis_mode == "openai" else None
    return _finalize_summary(
        summary=summary,
        analysis_mode="heuristic",
        prompt_version=AUTO_CLIP_ANALYZER_PROMPT_VERSION,
        provider=provider_name,
        model=model_name,
        request_id=request_id,
        provider_request_id=provider_request_id,
        usage=usage,
        latency_ms=round((perf_counter() - started) * 1000, 2),
        analysis_inputs=analysis_inputs,
        fallback_reason=fallback_reason,
    )


def _resolve_provider(provider_code: str) -> StructuredOutputProvider:
    if provider_code == "openai":
        return OpenAIStructuredOutputProvider()
    raise ValueError(f"Unsupported analyzer provider: {provider_code}")


def load_clip_analyzer_schema() -> dict[str, Any]:
    current = Path(__file__).resolve()
    relative = Path("packages") / "contracts" / "json-schema" / "clip-analyzer.schema.json"
    for parent in current.parents:
        candidate = parent / relative
        if candidate.exists():
            return json.loads(candidate.read_text(encoding="utf-8"))
    raise FileNotFoundError("clip-analyzer.schema.json could not be located from the Python worker runtime")


def _limit_and_score_candidates(
    candidates: list[CandidateAnalysis],
    analysis_inputs: AnalysisInputs,
    config: PipelineConfig,
) -> list[CandidateAnalysis]:
    filtered = [
        candidate
        for candidate in candidates
        if candidate.scores.get("final_viral_score", 0) >= config.minimum_viral_score
        and candidate.duration_seconds >= config.minimum_duration_seconds
        and candidate.duration_seconds <= config.maximum_duration_seconds
    ]
    normalized = normalize_candidates(filtered, analysis_inputs.scenes, analysis_inputs.silences)
    return deduplicate_and_rank(normalized, config.desired_clip_count)


def _finalize_summary(
    *,
    summary: dict[str, Any],
    analysis_mode: str,
    prompt_version: str,
    provider: str | None,
    model: str | None,
    request_id: str,
    provider_request_id: str | None,
    usage: dict[str, Any] | None,
    latency_ms: float,
    analysis_inputs: AnalysisInputs,
    fallback_reason: str | None,
) -> dict[str, Any]:
    analyzer_metadata = {
        "analysis_mode": analysis_mode,
        "prompt_version": prompt_version,
        "provider": provider,
        "model": model,
        "request_id": request_id,
        "provider_request_id": provider_request_id,
        "latency_ms": latency_ms,
        "token_usage": usage,
        "estimated_cost_usd": None,
        "input_segment_count": len(analysis_inputs.transcript.segments),
        "input_scene_count": len(analysis_inputs.scenes),
        "input_silence_count": len(analysis_inputs.silences),
        "fallback_reason": fallback_reason,
    }
    summary["analysis_version"] = "2.4"
    summary["analyzer"] = analyzer_metadata

    logger.info(
        "phase2 candidate analysis completed",
        extra={
            "request_id": request_id,
            "provider_request_id": provider_request_id,
            "analysis_mode": analysis_mode,
            "prompt_version": prompt_version,
            "provider": provider,
            "model": model,
            "latency_ms": latency_ms,
            "candidate_count": summary["candidate_count"],
            "token_usage": usage,
            "fallback_reason": fallback_reason,
        },
    )
    return summary
