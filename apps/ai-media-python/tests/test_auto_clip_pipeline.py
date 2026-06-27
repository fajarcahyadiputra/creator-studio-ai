from typing import Any

import pytest

from app.application.phase2_candidate_analyzer import (
    analyze_phase2_candidates_with_fallback,
    load_clip_analyzer_schema,
)
from app.domain.auto_clip_pipeline import (
    build_candidate_analyses,
    build_output_summary,
    build_pipeline_config,
    deduplicate_and_rank,
)
from app.domain.auto_clip_stages import compute_overall_progress
from app.domain.contracts import AnalysisInputs
from app.providers.base import ProviderRequestContext, StructuredOutputProvider


def analysis_inputs() -> AnalysisInputs:
    return AnalysisInputs.model_validate(
        {
            "transcript": {
                "language": "id",
                "duration_seconds": 78.0,
                "segments": [
                    {
                        "segment_id": "s1",
                        "start_seconds": 0.0,
                        "end_seconds": 12.0,
                        "text": "Kebanyakan orang salah memahami strategi konten ini.",
                        "speaker_label": "SPEAKER_01",
                    },
                    {
                        "segment_id": "s2",
                        "start_seconds": 12.0,
                        "end_seconds": 28.0,
                        "text": "Padahal justru bagian pembuka yang menentukan retention paling besar.",
                        "speaker_label": "SPEAKER_01",
                    },
                    {
                        "segment_id": "s3",
                        "start_seconds": 28.0,
                        "end_seconds": 46.0,
                        "text": "Kalau hook-nya lambat, penonton sudah pergi sebelum insight utamanya muncul.",
                        "speaker_label": "SPEAKER_02",
                    },
                    {
                        "segment_id": "s4",
                        "start_seconds": 46.0,
                        "end_seconds": 64.0,
                        "text": "Makanya banyak creator gagal bukan karena idenya buruk, tapi karena pembukanya lemah.",
                        "speaker_label": "SPEAKER_02",
                    },
                ],
            },
            "scenes": [
                {"scene_id": "scene-1", "start_seconds": 0.0, "end_seconds": 30.0},
                {"scene_id": "scene-2", "start_seconds": 30.0, "end_seconds": 64.0},
            ],
            "silences": [
                {"silence_id": "silence-1", "start_seconds": 27.8, "end_seconds": 28.2},
            ],
        }
    )


def test_stage_progress_is_weighted() -> None:
    assert compute_overall_progress("VALIDATING_SOURCE", 100) > compute_overall_progress("VALIDATING_SOURCE", 10)
    assert compute_overall_progress("TRANSCRIBING", 100) > compute_overall_progress("PROBING_MEDIA", 100)


def test_pipeline_builds_ranked_candidates() -> None:
    config = build_pipeline_config(
        {
            "strategy": {
                "desired_clip_count": 2,
                "minimum_duration_seconds": 15,
                "maximum_duration_seconds": 45,
                "minimum_viral_score": 6.5,
            }
        }
    )
    candidates = build_candidate_analyses(analysis_inputs(), config)

    assert len(candidates) >= 1
    assert candidates[0].scores["final_viral_score"] >= 6.5
    assert candidates[0].title
    assert candidates[0].suggested_hashtags


def test_output_summary_is_json_ready() -> None:
    config = build_pipeline_config(
        {
            "strategy": {
                "desired_clip_count": 2,
                "minimum_duration_seconds": 15,
                "maximum_duration_seconds": 45,
                "minimum_viral_score": 6.5,
            }
        }
    )
    candidates = build_candidate_analyses(analysis_inputs(), config)
    summary = build_output_summary(deduplicate_and_rank(candidates, 2))
    assert summary["analysis_version"] == "2.0"
    assert isinstance(summary["source_summary"], str)
    assert summary["candidate_count"] >= 1


def test_shared_clip_analyzer_schema_is_available() -> None:
    schema = load_clip_analyzer_schema()
    assert schema["title"] == "ClipAnalyzerResult"
    assert "candidate_count" in schema["properties"]


class FakeOpenAIProvider(StructuredOutputProvider):
    async def generate_structured(
        self,
        *,
        context: ProviderRequestContext,
        system_prompt: str,
        input_payload: dict[str, Any],
        schema: dict[str, Any],
    ) -> dict[str, Any]:
        assert context.provider_code == "openai"
        assert context.model_identifier
        assert system_prompt
        assert input_payload["transcript_segments"]
        assert schema["type"] == "object"
        return {
            "output": {
                "analysis_version": "2.2",
                "source_summary": "OpenAI summary of the source material.",
                "candidate_count": 1,
                "candidates": [
                    {
                        "candidate_id": "candidate-openai-01",
                        "start_seconds": 12.0,
                        "end_seconds": 31.0,
                        "duration_seconds": 19.0,
                        "title": "OpenAI picked this hook",
                        "hook_text": "Kebanyakan orang salah memahami strategi konten ini.",
                        "ending_text": "Padahal justru bagian pembuka yang menentukan retention paling besar.",
                        "summary": "OpenAI structured candidate summary.",
                        "why_it_works": ["Strong opening claim."],
                        "content_category": "insight",
                        "context_complete": True,
                        "safety_notes": [],
                        "suggested_caption": "OpenAI generated caption.",
                        "suggested_cta": "Comment your take.",
                        "suggested_hashtags": ["#creatorstudio", "#openai"],
                        "thumbnail_text": "OpenAI picked this hook",
                        "speaker_ids": ["SPEAKER_01"],
                        "scene_ids": ["scene-1"],
                        "scores": {
                            "hook": 8.9,
                            "conflict": 7.8,
                            "emotion": 7.2,
                            "novelty": 7.9,
                            "comment_potential": 8.1,
                            "base_viral_score": 8.45,
                            "final_viral_score": 8.31,
                            "penalties": {
                                "context": 0,
                                "weak_ending": 0,
                                "slow_start": 0,
                                "duplicate": 0,
                                "unsafe_or_misleading": 0,
                                "cut_quality": 0,
                            },
                        },
                    }
                ]
            },
            "usage": {"input_tokens": 1200, "output_tokens": 280, "total_tokens": 1480},
            "provider_request_id": "req_openai_123",
        }


class FailingProvider(StructuredOutputProvider):
    async def generate_structured(
        self,
        *,
        context: ProviderRequestContext,
        system_prompt: str,
        input_payload: dict[str, Any],
        schema: dict[str, Any],
    ) -> dict[str, Any]:
        raise RuntimeError("simulated provider failure")


@pytest.mark.asyncio
async def test_phase2_analyzer_uses_openai_provider_when_available() -> None:
    summary = await analyze_phase2_candidates_with_fallback(
        analysis_inputs=analysis_inputs(),
        input_snapshot={
            "strategy": {
                "desired_clip_count": 2,
                "minimum_duration_seconds": 15,
                "maximum_duration_seconds": 45,
                "minimum_viral_score": 6.5,
                "target_platform": "YOUTUBE_SHORTS",
                "objective": "EDUCATION",
            }
        },
        provider=FakeOpenAIProvider(),
    )

    assert summary["analysis_version"] == "2.2"
    assert summary["candidate_count"] >= 1
    analyzer = summary["analyzer"]
    assert analyzer["analysis_mode"] == "openai"
    assert analyzer["prompt_version"] == "phase2-candidate-analyzer-v1"
    assert analyzer["provider"] == "openai"
    assert analyzer["provider_request_id"] == "req_openai_123"
    assert analyzer["token_usage"]["total_tokens"] == 1480
    assert isinstance(analyzer["request_id"], str)
    assert analyzer["request_id"]


@pytest.mark.asyncio
async def test_phase2_analyzer_falls_back_to_heuristic_when_provider_fails() -> None:
    summary = await analyze_phase2_candidates_with_fallback(
        analysis_inputs=analysis_inputs(),
        input_snapshot={
            "strategy": {
                "desired_clip_count": 2,
                "minimum_duration_seconds": 15,
                "maximum_duration_seconds": 45,
                "minimum_viral_score": 6.5,
                "target_platform": "YOUTUBE_SHORTS",
                "objective": "EDUCATION",
            }
        },
        provider=FailingProvider(),
    )

    assert summary["analysis_version"] == "2.2"
    assert summary["candidate_count"] >= 1
    analyzer = summary["analyzer"]
    assert analyzer["analysis_mode"] == "heuristic"
    assert analyzer["provider"] == "openai"
    assert analyzer["fallback_reason"] == "RuntimeError"
