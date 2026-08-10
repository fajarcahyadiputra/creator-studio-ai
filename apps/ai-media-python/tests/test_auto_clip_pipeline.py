from typing import Any

import pytest

from app.application.phase2_candidate_analyzer import (
    analyze_phase2_candidates_with_fallback,
    load_clip_analyzer_schema,
)
from app.domain.auto_clip_pipeline import (
    _apply_natural_tail_padding,
    build_candidate_analyses,
    build_candidate_analyses_with_audit,
    build_output_summary,
    build_pipeline_config,
    deduplicate_and_rank,
    ensure_complete_candidate_title,
    limit_and_score_candidates_with_quality_backfill,
    normalize_candidates,
)
from app.domain.auto_clip_stages import compute_overall_progress
from app.domain.contracts import AnalysisInputs, CandidateAnalysis, TranscriptSegment
from app.providers.base import ProviderRequestContext, StructuredOutputProvider


def test_natural_tail_padding_uses_silence_without_leaking_next_topic() -> None:
    segments = [
        TranscriptSegment(
            segment_id="payoff",
            start_seconds=0.0,
            end_seconds=8.0,
            text="Makanya keputusan besar sebaiknya menunggu emosi turun.",
        ),
        TranscriptSegment(
            segment_id="new-topic",
            start_seconds=8.35,
            end_seconds=12.0,
            text="Sekarang kita pindah ke topik berikutnya.",
        ),
    ]

    padded_end = _apply_natural_tail_padding(
        start_seconds=0.0,
        end_seconds=8.0,
        ending_text=segments[0].text,
        transcript_segments=segments,
        maximum_duration_seconds=30.0,
    )

    assert padded_end == 8.35


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


def candidate_analysis(candidate_id: str, *, start_seconds: float, score: float) -> CandidateAnalysis:
    return CandidateAnalysis(
        candidate_id=candidate_id,
        start_seconds=start_seconds,
        end_seconds=start_seconds + 30.0,
        duration_seconds=30.0,
        title=f"Kandidat viral {candidate_id}",
        hook_text="Kenapa momen ini penting untuk dipahami sekarang?",
        ending_text="Makanya bagian ini tetap punya payoff yang jelas.",
        summary=f"Kandidat {candidate_id} membahas insight singkat dengan payoff jelas.",
        why_it_works=["Hook jelas dan punya payoff."],
        content_category="insight",
        context_complete=True,
        safety_notes=[],
        suggested_caption="Insight ini bisa memicu diskusi penonton.",
        suggested_cta="Komentar pendapat kamu.",
        related_hashtags=["#Insight"],
        viral_hashtags=["#FYP"],
        suggested_hashtags=["#Insight", "#FYP"],
        thumbnail_text=f"Kandidat viral {candidate_id}",
        speaker_ids=["SPEAKER_01"],
        scene_ids=["scene-1"],
        hook_second=0.0,
        main_point_second=10.0,
        punchline_second=29.0,
        retention_level="high",
        requires_context=False,
        can_standalone=True,
        scores={
            "hook": 8.0,
            "conflict": 7.0,
            "emotion": 7.0,
            "novelty": 7.0,
            "comment_potential": 7.5,
            "base_viral_score": score,
            "final_viral_score": score,
            "penalties": {
                "context": 0,
                "weak_ending": 0,
                "slow_start": 0,
                "duplicate": 0,
                "unsafe_or_misleading": 0,
                "cut_quality": 0,
            },
        },
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
    assert candidates[0].related_hashtags
    assert candidates[0].viral_hashtags
    assert candidates[0].suggested_hashtags
    assert candidates[0].retention_level in {"very_high", "high", "medium", "low"}
    assert candidates[0].punchline_second <= candidates[0].duration_seconds
    assert candidates[0].duration_seconds >= 15


def test_pipeline_backfills_when_minimum_score_is_too_strict_for_requested_count() -> None:
    config = build_pipeline_config(
        {
            "strategy": {
                "desired_clip_count": 2,
                "candidate_pool_count": 2,
                "minimum_duration_seconds": 15,
                "maximum_duration_seconds": 45,
                "minimum_viral_score": 8.0,
            }
        }
    )

    candidates, audit = build_candidate_analyses_with_audit(analysis_inputs(), config)

    assert len(candidates) >= 2
    assert audit["accepted_before_normalization"] < config.desired_clip_count
    assert audit["quality_backfill_count"] > 0
    assert all(candidate.duration_seconds >= config.minimum_duration_seconds for candidate in candidates)


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
    assert summary["analysis_version"] == "2.4"
    assert isinstance(summary["source_summary"], str)
    assert summary["candidate_count"] >= 1


def test_pipeline_applies_strategy_preferences_to_candidates() -> None:
    config = build_pipeline_config(
        {
            "strategy": {
                "desired_clip_count": 2,
                "minimum_duration_seconds": 15,
                "maximum_duration_seconds": 45,
                "minimum_viral_score": 6.0,
                "preferred_topics": ["retention"],
                "topics_to_avoid": ["politik"],
                "sensitive_topics": ["salah"],
                "cta_preference": "Save this and follow for part two.",
            }
        }
    )

    candidates = build_candidate_analyses(analysis_inputs(), config)

    assert candidates
    assert candidates[0].suggested_cta == "Save this and follow for part two."
    assert any("sensitive topic" in note.lower() for note in candidates[0].safety_notes)
    assert candidates[0].scores["final_viral_score"] >= candidates[0].scores["base_viral_score"] - 0.5


def test_candidate_backfill_keeps_requested_count_when_quality_floor_is_strict() -> None:
    config = build_pipeline_config(
        {
            "strategy": {
                "desired_clip_count": 5,
                "candidate_pool_count": 10,
                "minimum_duration_seconds": 15,
                "maximum_duration_seconds": 45,
                "minimum_viral_score": 7.5,
            }
        }
    )
    candidates = [
        candidate_analysis(f"candidate-{index}", start_seconds=index * 50.0, score=score)
        for index, score in enumerate([8.1, 7.8, 7.6, 7.2, 6.9, 6.2], start=1)
    ]

    ranked, audit = limit_and_score_candidates_with_quality_backfill(candidates, analysis_inputs(), config)

    assert len(ranked) == 5
    assert audit["accepted_after_deduplication"] < config.desired_clip_count
    assert audit["accepted_after_quantity_backfill"] == 5
    assert audit["quality_backfill_count"] + audit["quantity_backfill_count"] > 0


def test_pipeline_title_avoids_weak_filler_opening_words() -> None:
    short_input = AnalysisInputs.model_validate(
        {
            "transcript": {
                "language": "id",
                "duration_seconds": 25.0,
                "segments": [
                    {
                        "segment_id": "s1",
                        "start_seconds": 0.0,
                        "end_seconds": 8.0,
                        "text": "Oke jadi kalau pipa dikasih tekanan tinggi, jadinya kayak gimana mas?",
                        "speaker_label": "SPEAKER_01",
                    },
                    {
                        "segment_id": "s2",
                        "start_seconds": 8.0,
                        "end_seconds": 18.0,
                        "text": "Kalau tekanannya kelewatan, pipanya bisa retak atau bahkan pecah.",
                        "speaker_label": "SPEAKER_01",
                    },
                ],
            },
            "scenes": [{"scene_id": "scene-1", "start_seconds": 0.0, "end_seconds": 18.0}],
            "silences": [],
        }
    )
    config = build_pipeline_config(
        {
            "strategy": {
                "desired_clip_count": 1,
                "minimum_duration_seconds": 12,
                "maximum_duration_seconds": 30,
                "minimum_viral_score": 6.0,
            }
        }
    )

    candidates = build_candidate_analyses(short_input, config)

    assert candidates
    assert candidates[0].title.lower() != "oke"
    assert "tekanan" in candidates[0].title.lower() or "pecah" in candidates[0].title.lower()


def test_provider_title_with_ungrounded_comparison_is_repaired() -> None:
    repaired = ensure_complete_candidate_title(
        "Doom scrolling Bisa Lebih Parah dari Korban",
        hook_text="Doom scrolling membuat kejadian buruk terasa terjadi terus.",
        summary="Paparan berita berulang membuat sistem stres terus berputar dan dapat memicu trauma.",
        ending_text="Karena otak membaca kejadiannya seperti terjadi terus.",
    )

    assert repaired != "Doom scrolling Bisa Lebih Parah dari Korban"
    assert repaired.lower().split()[-1] not in {"dari", "karena", "yang", "dan"}
    assert "korban" not in repaired.lower()


def test_complete_provider_title_is_preserved() -> None:
    title = "Doom Scrolling Bisa Memicu Trauma"

    repaired = ensure_complete_candidate_title(
        title,
        hook_text="Doom scrolling membuat kejadian buruk terasa terjadi terus.",
        summary="Paparan berita berulang dapat memicu trauma.",
        ending_text="Sistem stres akhirnya terus berputar.",
    )

    assert repaired == title


def test_heuristic_title_is_not_cut_at_a_fixed_word_count() -> None:
    repaired = ensure_complete_candidate_title(
        "",
        hook_text="Doom scrolling membuat sistem stres terus berputar tanpa sempat pulih.",
        summary="Doom scrolling membuat sistem stres terus berputar tanpa sempat pulih.",
        ending_text="Sistem stres tidak sempat pulih.",
    )

    assert repaired.endswith("pulih")


def test_pipeline_rejects_internal_reintro_and_topic_reset_segments() -> None:
    reset_input = AnalysisInputs.model_validate(
        {
            "transcript": {
                "language": "id",
                "duration_seconds": 44.0,
                "segments": [
                    {
                        "segment_id": "s1",
                        "start_seconds": 0.0,
                        "end_seconds": 8.0,
                        "text": "Kenapa doom scrolling bisa bikin stress level naik terus setiap hari?",
                        "speaker_label": "SPEAKER_01",
                    },
                    {
                        "segment_id": "s2",
                        "start_seconds": 8.0,
                        "end_seconds": 16.0,
                        "text": "Karena sistemnya nge-loop, badan merasa ancamannya tidak pernah selesai.",
                        "speaker_label": "SPEAKER_01",
                    },
                    {
                        "segment_id": "s3",
                        "start_seconds": 16.0,
                        "end_seconds": 20.0,
                        "text": "Makanya orang bisa capek mental walau cuma scroll berita terus.",
                        "speaker_label": "SPEAKER_01",
                    },
                    {
                        "segment_id": "s4",
                        "start_seconds": 26.12,
                        "end_seconds": 34.16,
                        "text": "Halo para pemabuk, balik lagi di podcast kita bersama gue Bigeli Muria.",
                        "speaker_label": "SPEAKER_02",
                    },
                    {
                        "segment_id": "s5",
                        "start_seconds": 34.16,
                        "end_seconds": 42.56,
                        "text": "Dan hari ini kita mau ngobrolin topik yang relevan banget buat semua orang.",
                        "speaker_label": "SPEAKER_02",
                    },
                ],
            },
            "scenes": [{"scene_id": "scene-1", "start_seconds": 0.0, "end_seconds": 42.56}],
            "silences": [],
        }
    )
    config = build_pipeline_config(
        {
            "strategy": {
                "desired_clip_count": 2,
                "minimum_duration_seconds": 12,
                "maximum_duration_seconds": 45,
                "minimum_viral_score": 6.0,
            }
        }
    )

    candidates = build_candidate_analyses(reset_input, config)

    assert all(candidate.end_seconds <= 20.0 for candidate in candidates)
    assert all("halo para pemabuk" not in candidate.summary.lower() for candidate in candidates)
    assert all("podcast kita" not in candidate.summary.lower() for candidate in candidates)


def test_normalize_candidates_does_not_extend_into_reintro() -> None:
    transcript_segments = AnalysisInputs.model_validate(
        {
            "transcript": {
                "language": "id",
                "duration_seconds": 28.0,
                "segments": [
                    {
                        "segment_id": "s1",
                        "start_seconds": 0.0,
                        "end_seconds": 7.0,
                        "text": "Kalau stress terus, badannya ngira ancamannya belum selesai.",
                        "speaker_label": "SPEAKER_01",
                    },
                    {
                        "segment_id": "s2",
                        "start_seconds": 7.0,
                        "end_seconds": 14.0,
                        "text": "Makanya hormon waspadanya terus tinggi dan orang susah tenang karena",
                        "speaker_label": "SPEAKER_01",
                    },
                    {
                        "segment_id": "s3",
                        "start_seconds": 14.0,
                        "end_seconds": 18.0,
                        "text": "halo teman-teman, balik lagi di podcast kita.",
                        "speaker_label": "SPEAKER_02",
                    },
                ],
            },
            "scenes": [{"scene_id": "scene-1", "start_seconds": 0.0, "end_seconds": 18.0}],
            "silences": [],
        }
    ).transcript.segments
    candidate = CandidateAnalysis.model_validate(
        {
            "candidate_id": "candidate-reintro-cutoff-01",
            "start_seconds": 0.0,
            "end_seconds": 14.0,
            "duration_seconds": 14.0,
            "title": "Stress bikin badan siaga terus",
            "hook_text": "Kalau stress terus, badannya ngira ancamannya belum selesai.",
            "ending_text": "Makanya hormon waspadanya terus tinggi dan orang susah tenang karena",
            "summary": "Clip edukasi tentang stress dan sistem tubuh.",
            "why_it_works": ["Ada hook dan payoff."],
            "content_category": "insight",
            "context_complete": True,
            "safety_notes": [],
            "suggested_caption": "Clip edukasi tentang stress dan sistem tubuh.",
            "suggested_cta": "Comment your take.",
            "suggested_hashtags": ["#creatorstudio"],
            "thumbnail_text": "Stress bikin badan siaga terus",
            "speaker_ids": ["SPEAKER_01"],
            "scene_ids": ["scene-1"],
            "hook_second": 0.0,
            "main_point_second": 5.0,
            "punchline_second": 14.0,
            "retention_level": "high",
            "requires_context": False,
            "can_standalone": True,
            "scores": {
                "hook": 8.2,
                "conflict": 7.2,
                "emotion": 7.0,
                "novelty": 7.0,
                "comment_potential": 7.2,
                "base_viral_score": 7.9,
                "final_viral_score": 7.9,
                "penalties": {
                    "context": 0,
                    "weak_ending": 0.35,
                    "slow_start": 0,
                    "duplicate": 0,
                    "unsafe_or_misleading": 0,
                    "cut_quality": 0,
                },
            },
        }
    )

    normalized = normalize_candidates([candidate], [], [], transcript_segments, 30.0)

    assert normalized[0].end_seconds == 14.0
    assert "halo teman-teman" not in normalized[0].ending_text.lower()


def test_normalize_candidates_extends_incomplete_explanatory_endings() -> None:
    inputs = analysis_inputs()
    candidate = CandidateAnalysis.model_validate(
        {
            "candidate_id": "candidate-cutoff-01",
            "start_seconds": 12.0,
            "end_seconds": 28.0,
            "duration_seconds": 16.0,
            "title": "Padahal pembuka yang penting",
            "hook_text": "Padahal justru bagian pembuka yang menentukan retention paling besar.",
            "ending_text": "Kalau hook-nya lambat, penonton sudah pergi sebelum insight utamanya muncul karena",
            "summary": "Clip berhenti saat penjelasan masih menggantung.",
            "why_it_works": ["Ada hook dan insight."],
            "content_category": "insight",
            "context_complete": True,
            "safety_notes": [],
            "suggested_caption": "Clip berhenti saat penjelasan masih menggantung.",
            "suggested_cta": "Comment your take.",
            "suggested_hashtags": ["#creatorstudio"],
            "thumbnail_text": "Padahal pembuka yang penting",
            "speaker_ids": ["SPEAKER_01"],
            "scene_ids": ["scene-1"],
            "hook_second": 0.0,
            "main_point_second": 4.0,
            "punchline_second": 16.0,
            "retention_level": "high",
            "requires_context": False,
            "can_standalone": True,
            "scores": {
                "hook": 8.5,
                "conflict": 7.5,
                "emotion": 6.9,
                "novelty": 7.0,
                "comment_potential": 7.4,
                "base_viral_score": 8.0,
                "final_viral_score": 8.0,
                "penalties": {
                    "context": 0,
                    "weak_ending": 0.35,
                    "slow_start": 0,
                    "duplicate": 0,
                    "unsafe_or_misleading": 0,
                    "cut_quality": 0,
                },
            },
        }
    )

    normalized = normalize_candidates(
        [candidate],
        inputs.scenes,
        inputs.silences,
        inputs.transcript.segments,
        45.0,
    )

    assert normalized[0].end_seconds > candidate.end_seconds
    assert "Makanya banyak creator gagal" in normalized[0].ending_text


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
                "analysis_version": "2.4",
                "source_summary": "OpenAI summary of the source material.",
                "candidate_count": 2,
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
                        "hook_second": 0.0,
                        "main_point_second": 12.0,
                        "punchline_second": 19.0,
                        "retention_level": "very_high",
                        "requires_context": False,
                        "can_standalone": True,
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
                    },
                    {
                        "candidate_id": "candidate-openai-02",
                        "start_seconds": 13.0,
                        "end_seconds": 31.5,
                        "duration_seconds": 18.5,
                        "title": "OpenAI picked a nearly identical hook",
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
                        "hook_second": 0.0,
                        "main_point_second": 12.0,
                        "punchline_second": 18.5,
                        "retention_level": "high",
                        "requires_context": False,
                        "can_standalone": True,
                        "scores": {
                            "hook": 8.7,
                            "conflict": 7.7,
                            "emotion": 7.1,
                            "novelty": 7.8,
                            "comment_potential": 7.9,
                            "base_viral_score": 8.22,
                            "final_viral_score": 8.12,
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

    assert summary["analysis_version"] == "2.4"
    assert summary["candidate_count"] == 1
    analyzer = summary["analyzer"]
    assert analyzer["analysis_mode"] == "openai"
    assert analyzer["prompt_version"] == "phase2-candidate-analyzer-v11"
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

    assert summary["analysis_version"] == "2.4"
    assert summary["candidate_count"] >= 1
    analyzer = summary["analyzer"]
    assert analyzer["analysis_mode"] == "heuristic"
    assert analyzer["provider"] == "openai"
    assert analyzer["fallback_reason"] == "RuntimeError"
