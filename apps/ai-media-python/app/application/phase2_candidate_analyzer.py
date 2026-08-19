import logging
import json
from pathlib import Path
from time import perf_counter
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.config import get_settings
from app.domain.auto_clip_pipeline import (
    build_candidate_analyses_with_audit,
    build_output_summary,
    build_pipeline_config,
    resolve_auto_strategy,
    ensure_complete_candidate_title,
    limit_and_score_candidates_with_quality_backfill,
    PipelineConfig,
    supplement_ranked_candidates,
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
    analyzer: dict[str, Any] = Field(default_factory=dict)
    # Provider output is validated per candidate below so one malformed item
    # cannot discard the complete OpenAI batch.
    candidates: list[Any] = Field(default_factory=list, max_length=30)


async def analyze_phase2_candidates_with_fallback(
    *,
    analysis_inputs: AnalysisInputs,
    input_snapshot: dict[str, Any],
    provider: StructuredOutputProvider | None = None,
) -> dict[str, Any]:
    settings = get_settings()
    request_id = str(uuid4())
    started = perf_counter()
    effective_snapshot = resolve_auto_strategy(input_snapshot, analysis_inputs)
    config = build_pipeline_config(effective_snapshot, analysis_inputs)
    prompt_payload = build_candidate_analyzer_payload(analysis_inputs, effective_snapshot)
    system_prompt = build_candidate_analyzer_system_prompt(
        str(prompt_payload.get("language") or "id")
    )
    runtime_config = _resolve_analyzer_runtime_config(input_snapshot)

    provider_code = runtime_config["provider"]
    model_identifier = runtime_config["model"]
    configured_mode = runtime_config["mode"]

    usage: dict[str, Any] | None = None
    provider_request_id: str | None = None
    fallback_reason: str | None = None
    fallback_trigger: str | None = None
    provider_candidate_audit: dict[str, Any] | None = None

    if configured_mode == "openai_then_heuristic":
        openai_summary: dict[str, Any] | None = None
        try:
            openai_summary, usage, provider_request_id, provider_candidate_audit = await _run_openai_analysis(
                provider=provider,
                provider_code=provider_code,
                model_identifier=model_identifier,
                request_id=request_id,
                system_prompt=system_prompt,
                prompt_payload=prompt_payload,
                analysis_inputs=analysis_inputs,
                config=config,
            )
            accepted, rejection_reason = _should_accept_summary(openai_summary, config)
            if accepted:
                if config.configuration_mode == "AUTO":
                    heuristic_summary = _run_heuristic_analysis(analysis_inputs, config)
                    summary, supplemental_count = _supplement_openai_summary(
                        openai_summary=openai_summary,
                        heuristic_summary=heuristic_summary,
                        config=config,
                    )
                    return _finalize_summary(
                        summary=summary,
                        analysis_mode="hybrid" if supplemental_count > 0 else "openai",
                        configured_mode=configured_mode,
                        prompt_version=AUTO_CLIP_ANALYZER_PROMPT_VERSION,
                        provider=provider_code,
                        model=model_identifier,
                        attempted_provider=provider_code,
                        attempted_model=model_identifier,
                        request_id=request_id,
                        provider_request_id=provider_request_id,
                        usage=usage,
                        latency_ms=round((perf_counter() - started) * 1000, 2),
                        analysis_inputs=analysis_inputs,
                        effective_config=config,
                        fallback_reason=None,
                        fallback_trigger=None,
                        candidate_source_counts={
                            "openai": int(openai_summary["candidate_count"]),
                            "heuristic": supplemental_count,
                        },
                        provider_candidate_audit=provider_candidate_audit,
                    )
                return _finalize_summary(
                    summary=openai_summary,
                    analysis_mode="openai",
                    configured_mode=configured_mode,
                    prompt_version=AUTO_CLIP_ANALYZER_PROMPT_VERSION,
                    provider=provider_code,
                    model=model_identifier,
                    attempted_provider=provider_code,
                    attempted_model=model_identifier,
                    request_id=request_id,
                    provider_request_id=provider_request_id,
                    usage=usage,
                    latency_ms=round((perf_counter() - started) * 1000, 2),
                    analysis_inputs=analysis_inputs,
                    effective_config=config,
                    fallback_reason=None,
                    fallback_trigger=None,
                    candidate_source_counts={"openai": int(openai_summary["candidate_count"]), "heuristic": 0},
                    provider_candidate_audit=provider_candidate_audit,
                )
            fallback_trigger = rejection_reason
        except Exception as error:
            fallback_reason = type(error).__name__
            extra_payload = {
                "request_id": request_id,
                "provider": provider_code,
                "model": model_identifier,
                "error_type": type(error).__name__,
            }
            if isinstance(error, ValidationError):
                extra_payload["validation_errors"] = error.errors(include_url=False)
            logger.warning(
                "OpenAI phase2 analyzer failed; falling back to heuristic scoring",
                extra=extra_payload,
            )
            fallback_trigger = fallback_trigger or "openai_failed"

        heuristic_summary = _run_heuristic_analysis(analysis_inputs, config)
        if openai_summary is not None and int(openai_summary.get("candidate_count", 0)) > 0:
            summary, supplemental_count = _supplement_openai_summary(
                openai_summary=openai_summary,
                heuristic_summary=heuristic_summary,
                config=config,
            )
            return _finalize_summary(
                summary=summary,
                analysis_mode="hybrid" if supplemental_count > 0 else "openai",
                configured_mode=configured_mode,
                prompt_version=AUTO_CLIP_ANALYZER_PROMPT_VERSION,
                provider=provider_code,
                model=model_identifier,
                attempted_provider=provider_code,
                attempted_model=model_identifier,
                request_id=request_id,
                provider_request_id=provider_request_id,
                usage=usage,
                latency_ms=round((perf_counter() - started) * 1000, 2),
                analysis_inputs=analysis_inputs,
                effective_config=config,
                fallback_reason=None,
                fallback_trigger=fallback_trigger,
                candidate_source_counts={
                    "openai": int(openai_summary["candidate_count"]),
                    "heuristic": supplemental_count,
                },
                provider_candidate_audit=provider_candidate_audit,
            )

        summary = heuristic_summary
        return _finalize_summary(
            summary=summary,
            analysis_mode="heuristic",
            configured_mode=configured_mode,
            prompt_version=AUTO_CLIP_ANALYZER_PROMPT_VERSION,
            provider=None,
            model=None,
            attempted_provider=provider_code,
            attempted_model=model_identifier,
            request_id=request_id,
            provider_request_id=provider_request_id,
            usage=usage,
            latency_ms=round((perf_counter() - started) * 1000, 2),
            analysis_inputs=analysis_inputs,
            effective_config=config,
            fallback_reason=fallback_reason,
            fallback_trigger=fallback_trigger,
            candidate_source_counts={"openai": 0, "heuristic": int(summary["candidate_count"])},
        )

    summary = _run_heuristic_analysis(analysis_inputs, config)
    accepted, rejection_reason = _should_accept_summary(summary, config)
    if configured_mode == "heuristic_then_openai" and not accepted:
        fallback_trigger = rejection_reason
        try:
            summary, usage, provider_request_id, provider_candidate_audit = await _run_openai_analysis(
                provider=provider,
                provider_code=provider_code,
                model_identifier=model_identifier,
                request_id=request_id,
                system_prompt=system_prompt,
                prompt_payload=prompt_payload,
                analysis_inputs=analysis_inputs,
                config=config,
            )
            return _finalize_summary(
                summary=summary,
                analysis_mode="openai",
                configured_mode=configured_mode,
                prompt_version=AUTO_CLIP_ANALYZER_PROMPT_VERSION,
                provider=provider_code,
                model=model_identifier,
                attempted_provider=provider_code,
                attempted_model=model_identifier,
                request_id=request_id,
                provider_request_id=provider_request_id,
                usage=usage,
                latency_ms=round((perf_counter() - started) * 1000, 2),
                analysis_inputs=analysis_inputs,
                effective_config=config,
                fallback_reason=None,
                fallback_trigger=fallback_trigger,
                candidate_source_counts={"openai": int(summary["candidate_count"]), "heuristic": 0},
                provider_candidate_audit=provider_candidate_audit,
            )
        except Exception as error:
            fallback_reason = type(error).__name__
            logger.warning(
                "Heuristic phase2 analyzer produced insufficient candidates; OpenAI fallback failed, keeping heuristic result",
                extra={
                    "request_id": request_id,
                    "provider": provider_code,
                    "model": model_identifier,
                    "error_type": type(error).__name__,
                    "fallback_trigger": fallback_trigger,
                },
            )

    return _finalize_summary(
        summary=summary,
        analysis_mode="heuristic",
        configured_mode=configured_mode,
        prompt_version=AUTO_CLIP_ANALYZER_PROMPT_VERSION,
        provider=None,
        model=None,
        attempted_provider=provider_code if fallback_reason or configured_mode == "heuristic_then_openai" and not accepted else None,
        attempted_model=model_identifier if fallback_reason or configured_mode == "heuristic_then_openai" and not accepted else None,
        request_id=request_id,
        provider_request_id=provider_request_id,
        usage=usage,
        latency_ms=round((perf_counter() - started) * 1000, 2),
        analysis_inputs=analysis_inputs,
        effective_config=config,
        fallback_reason=fallback_reason,
        fallback_trigger=fallback_trigger,
        candidate_source_counts={"openai": 0, "heuristic": int(summary["candidate_count"])},
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
    candidates, _ = _limit_and_score_candidates_with_audit(candidates, analysis_inputs, config)
    return candidates


def _limit_and_score_candidates_with_audit(
    candidates: list[CandidateAnalysis],
    analysis_inputs: AnalysisInputs,
    config: PipelineConfig,
) -> tuple[list[CandidateAnalysis], dict[str, Any]]:
    return limit_and_score_candidates_with_quality_backfill(candidates, analysis_inputs, config)


def _finalize_summary(
    *,
    summary: dict[str, Any],
    analysis_mode: str,
    configured_mode: str,
    prompt_version: str,
    provider: str | None,
    model: str | None,
    attempted_provider: str | None,
    attempted_model: str | None,
    request_id: str,
    provider_request_id: str | None,
    usage: dict[str, Any] | None,
    latency_ms: float,
    analysis_inputs: AnalysisInputs,
    effective_config: PipelineConfig,
    fallback_reason: str | None,
    fallback_trigger: str | None,
    candidate_source_counts: dict[str, int] | None = None,
    provider_candidate_audit: dict[str, Any] | None = None,
) -> dict[str, Any]:
    analyzer_metadata = {
        "analysis_mode": analysis_mode,
        "configured_mode": configured_mode,
        "prompt_version": prompt_version,
        "provider": provider,
        "model": model,
        "attempted_provider": attempted_provider,
        "attempted_model": attempted_model,
        "request_id": request_id,
        "provider_request_id": provider_request_id,
        "latency_ms": latency_ms,
        "token_usage": usage,
        "estimated_cost_usd": None,
        "input_segment_count": len(analysis_inputs.transcript.segments),
        "input_scene_count": len(analysis_inputs.scenes),
        "input_silence_count": len(analysis_inputs.silences),
        "fallback_reason": fallback_reason,
        "fallback_trigger": fallback_trigger,
        "candidate_source_counts": candidate_source_counts or {},
        "provider_candidate_audit": provider_candidate_audit or {},
        "effective_configuration": {
            "mode": effective_config.configuration_mode if effective_config else "MANUAL",
            "desired_clip_count": effective_config.desired_clip_count if effective_config else None,
            "candidate_pool_count": effective_config.candidate_pool_count if effective_config else None,
            "minimum_duration_seconds": effective_config.minimum_duration_seconds if effective_config else None,
            "maximum_duration_seconds": effective_config.maximum_duration_seconds if effective_config else None,
            "minimum_viral_score": effective_config.minimum_viral_score if effective_config else None,
        },
    }
    summary["analysis_version"] = "2.4"
    summary["analyzer"] = analyzer_metadata

    logger.info(
        "phase2 candidate analysis completed",
        extra={
            "request_id": request_id,
            "provider_request_id": provider_request_id,
            "analysis_mode": analysis_mode,
            "configured_mode": configured_mode,
            "prompt_version": prompt_version,
            "provider": provider,
            "model": model,
            "latency_ms": latency_ms,
            "candidate_count": summary["candidate_count"],
            "token_usage": usage,
            "fallback_reason": fallback_reason,
            "fallback_trigger": fallback_trigger,
            "candidate_source_counts": candidate_source_counts or {},
            "provider_candidate_audit": provider_candidate_audit or {},
        },
    )
    return summary


def _resolve_analyzer_runtime_config(input_snapshot: dict[str, Any]) -> dict[str, Any]:
    settings = get_settings()
    default_mode = str(settings.AUTO_CLIP_ANALYZER_MODE).strip().lower()
    if default_mode == "openai":
        default_mode = "openai_then_heuristic"
    elif default_mode not in {"openai_then_heuristic", "heuristic_then_openai", "heuristic"}:
        default_mode = "openai_then_heuristic"
    defaults = {
        "mode": default_mode,
        "provider": settings.AUTO_CLIP_ANALYZER_PROVIDER or "openai",
        "model": settings.AUTO_CLIP_ANALYZER_MODEL or "gpt-5.5",
    }

    ai = input_snapshot.get("ai")
    if not isinstance(ai, dict):
        return defaults

    runtime = ai.get("analyzer_runtime")
    if not isinstance(runtime, dict):
        return defaults

    mode = runtime.get("mode")
    provider = runtime.get("provider")
    model = runtime.get("model")
    return {
        "mode": mode if mode in {"openai_then_heuristic", "heuristic_then_openai", "heuristic"} else defaults["mode"],
        "provider": provider.strip().lower() if isinstance(provider, str) and provider.strip() else defaults["provider"],
        "model": model.strip() if isinstance(model, str) and model.strip() else defaults["model"],
    }


async def _run_openai_analysis(
    *,
    provider: StructuredOutputProvider | None,
    provider_code: str,
    model_identifier: str,
    request_id: str,
    system_prompt: str,
    prompt_payload: dict[str, Any],
    analysis_inputs: AnalysisInputs,
    config: PipelineConfig,
) -> tuple[dict[str, Any], dict[str, Any] | None, str | None, dict[str, Any]]:
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
        schema_name="auto_clip_candidate_batch",
    )
    normalized_output = _normalize_provider_batch_output(provider_result["output"])
    batch, batch_normalization_audit = _parse_provider_batch_tolerantly(normalized_output)
    valid_candidates: list[CandidateAnalysis] = []
    invalid_candidates: list[dict[str, Any]] = []
    for index, raw_candidate in enumerate(batch.candidates):
        try:
            valid_candidates.append(CandidateAnalysis.model_validate(raw_candidate))
        except ValidationError as error:
            invalid_candidates.append({
                "index": index,
                "candidate_id": (
                    str(raw_candidate.get("candidate_id"))
                    if isinstance(raw_candidate, dict) and raw_candidate.get("candidate_id") is not None
                    else None
                ),
                "errors": error.errors(include_url=False),
            })

    candidates, candidate_audit = _limit_and_score_candidates_with_audit(
        valid_candidates,
        analysis_inputs,
        config,
    )
    candidate_audit["provider_invalid_candidates"] = invalid_candidates
    candidate_audit["provider_valid_candidate_count"] = len(valid_candidates)
    candidate_audit["provider_declared_candidate_count"] = batch.candidate_count
    candidate_audit["provider_batch_normalization"] = batch_normalization_audit
    summary = build_output_summary(candidates, source_summary=batch.source_summary)
    usage = provider_result.get("usage") if isinstance(provider_result.get("usage"), dict) else None
    provider_request_id = (
        str(provider_result.get("provider_request_id"))
        if provider_result.get("provider_request_id") is not None
        else None
    )
    return summary, usage, provider_request_id, candidate_audit


def _parse_provider_batch_tolerantly(output: Any) -> tuple[CandidateBatchOutput, dict[str, Any]]:
    """Validate batch metadata without sacrificing individually valid candidates."""
    if not isinstance(output, dict):
        raise ValueError("OpenAI candidate batch must be an object")

    raw_candidates = output.get("candidates")
    candidates = raw_candidates[:30] if isinstance(raw_candidates, list) else []
    source_summary = str(output.get("source_summary") or "").strip()
    repaired_fields: list[str] = []
    if not source_summary:
        source_summary = "Candidate moments selected from the source transcript."
        repaired_fields.append("source_summary")

    analysis_version = str(output.get("analysis_version") or "1.0").strip() or "1.0"
    analyzer = output.get("analyzer") if isinstance(output.get("analyzer"), dict) else {}
    declared_count = output.get("candidate_count")
    if not isinstance(declared_count, int) or declared_count < 0 or declared_count > 30:
        declared_count = len(candidates)
        repaired_fields.append("candidate_count")

    batch = CandidateBatchOutput.model_validate(
        {
            "analysis_version": analysis_version[:40],
            "source_summary": source_summary[:2000],
            "candidate_count": declared_count,
            "analyzer": analyzer,
            "candidates": candidates,
        }
    )
    return batch, {
        "repaired_fields": repaired_fields,
        "received_candidate_count": len(raw_candidates) if isinstance(raw_candidates, list) else 0,
        "retained_candidate_count": len(candidates),
    }


def _normalize_provider_batch_output(output: Any) -> Any:
    if not isinstance(output, dict):
        return output

    candidates = output.get("candidates")
    if not isinstance(candidates, list):
        return output

    normalized_candidates: list[Any] = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            normalized_candidates.append(candidate)
            continue
        normalized_candidate = _normalize_candidate_time_markers(candidate)
        normalized_candidates.append(_normalize_candidate_title(normalized_candidate))

    normalized = dict(output)
    normalized["candidates"] = normalized_candidates
    return normalized


def _normalize_candidate_title(candidate: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(candidate)
    original_title = str(candidate.get("title") or "")
    repaired_title = ensure_complete_candidate_title(
        original_title,
        hook_text=str(candidate.get("hook_text") or ""),
        summary=str(candidate.get("summary") or ""),
        ending_text=str(candidate.get("ending_text") or ""),
    )
    normalized["title"] = repaired_title

    thumbnail_text = str(candidate.get("thumbnail_text") or "")
    if thumbnail_text.strip().lower() == original_title.strip().lower():
        normalized["thumbnail_text"] = repaired_title[:120].rstrip()
    return normalized


def _normalize_candidate_time_markers(candidate: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(candidate)

    start_seconds = _coerce_float(candidate.get("start_seconds"))
    end_seconds = _coerce_float(candidate.get("end_seconds"))
    duration_seconds = _coerce_float(candidate.get("duration_seconds"))

    if start_seconds is None or end_seconds is None or duration_seconds is None or end_seconds <= start_seconds:
        return normalized

    # Models occasionally return an endpoint with a tiny rounding overflow,
    # or mix absolute and relative timestamps. Normalize before Pydantic
    # validation so a single bad beat does not reject the whole provider batch.
    actual_duration = max(0.01, end_seconds - start_seconds)
    normalized["duration_seconds"] = round(actual_duration, 3)

    marker_values: dict[str, float] = {}
    for key in ("hook_second", "main_point_second", "punchline_second"):
        marker_value = _coerce_float(candidate.get(key))
        if marker_value is None:
            continue

        if marker_value > actual_duration and start_seconds <= marker_value <= end_seconds:
            marker_value -= start_seconds
        elif marker_value < 0:
            marker_value = 0.0
        marker_values[key] = max(0.0, min(marker_value, actual_duration))

    hook_second = marker_values.get("hook_second", 0.0)
    main_point_second = max(hook_second, marker_values.get("main_point_second", hook_second))
    punchline_second = max(main_point_second, marker_values.get("punchline_second", main_point_second))
    normalized.update({
        "hook_second": round(hook_second, 3),
        "main_point_second": round(main_point_second, 3),
        "punchline_second": round(min(punchline_second, actual_duration), 3),
    })

    return normalized


def _coerce_float(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _run_heuristic_analysis(analysis_inputs: AnalysisInputs, config: PipelineConfig) -> dict[str, Any]:
    candidates, candidate_audit = build_candidate_analyses_with_audit(analysis_inputs, config)
    summary = build_output_summary(candidates)
    summary["candidate_audit"] = candidate_audit
    return summary


def _supplement_openai_summary(
    *,
    openai_summary: dict[str, Any],
    heuristic_summary: dict[str, Any],
    config: PipelineConfig,
) -> tuple[dict[str, Any], int]:
    openai_candidates = [CandidateAnalysis.model_validate(item) for item in openai_summary.get("candidates", [])]
    heuristic_candidates = [CandidateAnalysis.model_validate(item) for item in heuristic_summary.get("candidates", [])]
    merged = supplement_ranked_candidates(
        openai_candidates,
        heuristic_candidates,
        config.desired_clip_count,
    )
    supplemental_count = max(0, len(merged) - len(openai_candidates))
    return build_output_summary(merged, source_summary=str(openai_summary.get("source_summary") or "")), supplemental_count


def _should_accept_summary(summary: dict[str, Any], config: PipelineConfig) -> tuple[bool, str | None]:
    candidate_count = int(summary.get("candidate_count", 0))
    if candidate_count <= 0:
        return False, "no_candidates"
    if config.configuration_mode == "AUTO":
        return True, None
    if candidate_count < max(1, config.desired_clip_count):
        return False, "insufficient_candidates"
    return True, None
