from dataclasses import dataclass
from hashlib import sha1
from typing import Iterable

from app.domain.clip_scoring import calculate_viral_score
from app.domain.contracts import (
    AnalysisInputs,
    CandidateAnalysis,
    ClipPenalties,
    ClipScoreComponents,
    SceneBoundary,
    SilenceBoundary,
    TranscriptDocument,
    TranscriptSegment,
)


@dataclass(frozen=True, slots=True)
class PipelineConfig:
    desired_clip_count: int
    candidate_pool_count: int
    minimum_duration_seconds: int
    maximum_duration_seconds: int
    minimum_viral_score: float
    preferred_topics: tuple[str, ...]
    topics_to_avoid: tuple[str, ...]
    sensitive_topics: tuple[str, ...]
    clip_style_tags: tuple[str, ...]
    virality_priorities: tuple[str, ...]
    cta_preference: str | None
    standalone_priority: str | None
    require_spoken_audio: bool


def build_pipeline_config(input_snapshot: dict[str, object]) -> PipelineConfig:
    strategy = input_snapshot.get("strategy")
    if not isinstance(strategy, dict):
        raise ValueError("strategy is required")
    desired_clip_count = int(strategy.get("desired_clip_count", 3))
    candidate_pool_count = int(strategy.get("candidate_pool_count", max(desired_clip_count, min(desired_clip_count * 2, 10))))
    return PipelineConfig(
        desired_clip_count=desired_clip_count,
        candidate_pool_count=max(desired_clip_count, min(candidate_pool_count, 30)),
        minimum_duration_seconds=int(strategy.get("minimum_duration_seconds", 15)),
        maximum_duration_seconds=int(strategy.get("maximum_duration_seconds", 60)),
        minimum_viral_score=float(strategy.get("minimum_viral_score", 7)),
        preferred_topics=_normalize_strategy_terms(strategy.get("preferred_topics")),
        topics_to_avoid=_normalize_strategy_terms(strategy.get("topics_to_avoid")),
        sensitive_topics=_normalize_strategy_terms(strategy.get("sensitive_topics")),
        clip_style_tags=_normalize_strategy_terms(strategy.get("clip_style_tags")),
        virality_priorities=_normalize_strategy_terms(strategy.get("virality_priorities")),
        cta_preference=_normalize_optional_text(strategy.get("cta_preference")),
        standalone_priority=_normalize_optional_text(strategy.get("standalone_priority")),
        require_spoken_audio=bool(strategy.get("require_spoken_audio", True)),
    )


def build_candidate_analyses(
    analysis_inputs: AnalysisInputs,
    config: PipelineConfig,
) -> list[CandidateAnalysis]:
    transcript = analysis_inputs.transcript
    windows = _build_segment_windows(transcript, config)
    candidates: list[CandidateAnalysis] = []
    for index, segments in enumerate(windows, start=1):
        if _window_should_be_rejected(segments):
            continue
        candidate = _candidate_from_segments(
            index=index,
            transcript=transcript,
            segments=segments,
            scenes=analysis_inputs.scenes,
            silences=analysis_inputs.silences,
            config=config,
        )
        if (
            candidate.scores["final_viral_score"] >= config.minimum_viral_score
            and candidate.duration_seconds >= config.minimum_duration_seconds
            and candidate.duration_seconds <= config.maximum_duration_seconds
        ):
            candidates.append(candidate)
    normalized = normalize_candidates(
        candidates,
        analysis_inputs.scenes,
        analysis_inputs.silences,
        analysis_inputs.transcript.segments,
        float(config.maximum_duration_seconds),
    )
    return deduplicate_and_rank(normalized, config.candidate_pool_count)


def normalize_candidates(
    candidates: list[CandidateAnalysis],
    scenes: list[SceneBoundary],
    silences: list[SilenceBoundary],
    transcript_segments: list[TranscriptSegment] | None = None,
    maximum_duration_seconds: float | None = None,
) -> list[CandidateAnalysis]:
    normalized: list[CandidateAnalysis] = []
    for candidate in candidates:
        start_seconds = _normalize_start(candidate.start_seconds, scenes, silences)
        end_seconds = _normalize_end(candidate.end_seconds, scenes, silences)
        ending_text = candidate.ending_text
        if transcript_segments:
            end_seconds, ending_text = _extend_candidate_end_to_complete_thought(
                start_seconds=start_seconds,
                end_seconds=end_seconds,
                ending_text=ending_text,
                transcript_segments=transcript_segments,
                maximum_duration_seconds=maximum_duration_seconds,
            )
        if end_seconds <= start_seconds:
            end_seconds = candidate.end_seconds
            start_seconds = candidate.start_seconds
        duration_seconds = round(end_seconds - start_seconds, 2)
        beat_offset = round(candidate.start_seconds - start_seconds, 2)
        hook_second, main_point_second, punchline_second = _normalize_story_beats(
            hook_second=candidate.hook_second + beat_offset,
            main_point_second=candidate.main_point_second + beat_offset,
            punchline_second=candidate.punchline_second + beat_offset,
            duration_seconds=duration_seconds,
        )
        normalized.append(
            candidate.model_copy(
                update={
                    "start_seconds": round(start_seconds, 2),
                    "end_seconds": round(end_seconds, 2),
                    "duration_seconds": duration_seconds,
                    "ending_text": ending_text,
                    "hook_second": hook_second,
                    "main_point_second": main_point_second,
                    "punchline_second": punchline_second,
                }
            )
        )
    return normalized


def deduplicate_and_rank(candidates: list[CandidateAnalysis], desired_count: int) -> list[CandidateAnalysis]:
    ranked = sorted(
        candidates,
        key=lambda item: (
            float(item.scores["final_viral_score"]),
            1 if item.can_standalone else 0,
            _retention_priority(item.retention_level),
            -len(item.safety_notes),
            -item.duration_seconds,
        ),
        reverse=True,
    )
    selected: list[CandidateAnalysis] = []
    for candidate in ranked:
        if len(selected) >= desired_count:
            break
        if any(
            _overlap_ratio(candidate, existing) > 0.6 or _text_similarity(candidate, existing) >= 0.82
            for existing in selected
        ):
            continue
        selected.append(candidate)
    return selected


def supplement_ranked_candidates(
    primary: list[CandidateAnalysis],
    supplemental: list[CandidateAnalysis],
    desired_count: int,
) -> list[CandidateAnalysis]:
    """Preserve primary analyzer picks and fill only missing, non-duplicate slots."""
    selected = list(primary[:desired_count])
    ranked_supplemental = sorted(
        supplemental,
        key=lambda item: (
            float(item.scores["final_viral_score"]),
            1 if item.can_standalone else 0,
            _retention_priority(item.retention_level),
            -len(item.safety_notes),
            -item.duration_seconds,
        ),
        reverse=True,
    )
    for candidate in ranked_supplemental:
        if len(selected) >= desired_count:
            break
        if any(
            _overlap_ratio(candidate, existing) > 0.6 or _text_similarity(candidate, existing) >= 0.82
            for existing in selected
        ):
            continue
        existing_ids = {item.candidate_id for item in selected}
        if candidate.candidate_id in existing_ids:
            base_id = f"heuristic-{candidate.candidate_id}"[:100]
            resolved_id = base_id
            suffix = 2
            while resolved_id in existing_ids:
                suffix_text = f"-{suffix}"
                resolved_id = f"{base_id[:100 - len(suffix_text)]}{suffix_text}"
                suffix += 1
            candidate = candidate.model_copy(update={"candidate_id": resolved_id})
        selected.append(candidate)
    return selected


def build_output_summary(candidates: list[CandidateAnalysis], *, source_summary: str | None = None) -> dict[str, object]:
    resolved_source_summary = source_summary or _build_source_summary(candidates)
    return {
        "analysis_version": "2.4",
        "source_summary": resolved_source_summary,
        "candidate_count": len(candidates),
        "candidates": [candidate.model_dump(mode="json") for candidate in candidates],
    }


def _build_segment_windows(
    transcript: TranscriptDocument,
    config: PipelineConfig,
) -> list[list[TranscriptSegment]]:
    windows: list[list[TranscriptSegment]] = []
    soft_minimum = max(12.0, min(float(config.minimum_duration_seconds), float(config.maximum_duration_seconds)))
    max_windows_per_start = 3

    for start_index in range(len(transcript.segments)):
        current: list[TranscriptSegment] = []
        windows_for_start = 0
        last_recorded_end: float | None = None
        for segment in transcript.segments[start_index:]:
            if current:
                previous_segment = current[-1]
                if _segments_have_large_gap(previous_segment, segment):
                    break
                if _segment_starts_topic_reset(segment.text):
                    break
            current.append(segment)
            duration = current[-1].end_seconds - current[0].start_seconds
            if duration > config.maximum_duration_seconds:
                break
            if _window_contains_internal_reset(current):
                break

            complete_idea = _window_has_complete_idea(current)
            natural_ending = _is_natural_ending_segment(segment.text)

            if complete_idea and (duration >= soft_minimum or duration >= 10.0):
                windows.append(list(current))
                windows_for_start += 1
                last_recorded_end = current[-1].end_seconds
                if windows_for_start >= max_windows_per_start:
                    break
                continue

            if (
                natural_ending
                and duration >= max(soft_minimum, config.maximum_duration_seconds * 0.8)
                and (last_recorded_end is None or (current[-1].end_seconds - last_recorded_end) >= 2.0)
            ):
                windows.append(list(current))
                windows_for_start += 1
                last_recorded_end = current[-1].end_seconds
                if windows_for_start >= max_windows_per_start:
                    break

        if len(windows) >= config.candidate_pool_count * 6:
            break

    return windows or [[transcript.segments[0]]]


def _candidate_from_segments(
    index: int,
    transcript: TranscriptDocument,
    segments: list[TranscriptSegment],
    scenes: list[SceneBoundary],
    silences: list[SilenceBoundary],
    config: PipelineConfig,
) -> CandidateAnalysis:
    combined_text = " ".join(segment.text.strip() for segment in segments)
    hook_text = segments[0].text.strip()
    ending_text = segments[-1].text.strip()
    hook_second = _resolve_hook_second(segments)
    main_point_second = _resolve_main_point_second(segments)
    punchline_second = _resolve_punchline_second(segments)
    requires_context = _requires_context(segments)
    can_standalone = _can_stand_alone(segments)
    preferred_topic_matches = _matching_terms(combined_text, config.preferred_topics)
    avoided_topic_matches = _matching_terms(combined_text, config.topics_to_avoid)
    sensitive_topic_matches = _matching_terms(combined_text, config.sensitive_topics)
    components = _score_text(hook_text, combined_text, hook_second=hook_second, duration_seconds=segments[-1].end_seconds - segments[0].start_seconds)
    penalties = ClipPenalties(
        context=0.8 if requires_context else (0 if len(segments) >= 2 else 0.35),
        weak_ending=0 if _is_natural_ending_segment(ending_text) else 0.35,
        slow_start=0 if hook_second <= 1.5 else 0.45,
        duplicate=0,
        unsafe_or_misleading=0,
        cut_quality=0.25 if _touches_silence(segments[0].start_seconds, segments[-1].end_seconds, silences) else 0,
    )
    score = calculate_viral_score(components, penalties)
    adjusted_final_score = _apply_score_adjustment(
        score.final,
        _strategy_score_adjustment(
            preferred_topic_matches=preferred_topic_matches,
            avoided_topic_matches=avoided_topic_matches,
            sensitive_topic_matches=sensitive_topic_matches,
            can_standalone=can_standalone,
            requires_context=requires_context,
        ),
    )
    scene_ids = [scene.scene_id for scene in scenes if _intersects(scene.start_seconds, scene.end_seconds, segments)]
    speaker_ids = sorted({segment.speaker_label for segment in segments if segment.speaker_label})
    summary = combined_text[:300]
    title = _build_title(combined_text, hook_text=hook_text, ending_text=ending_text)
    duration_seconds = round(segments[-1].end_seconds - segments[0].start_seconds, 2)
    hook_second, main_point_second, punchline_second = _normalize_story_beats(
        hook_second=hook_second,
        main_point_second=main_point_second,
        punchline_second=punchline_second,
        duration_seconds=duration_seconds,
    )
    return CandidateAnalysis(
        candidate_id=f"candidate-{index:02d}-{sha1(summary.encode('utf-8')).hexdigest()[:8]}",
        start_seconds=segments[0].start_seconds,
        end_seconds=segments[-1].end_seconds,
        duration_seconds=duration_seconds,
        title=title,
        hook_text=hook_text,
        ending_text=ending_text,
        summary=summary,
        why_it_works=_why_it_works(components),
        content_category=_content_category(combined_text),
        context_complete=not requires_context,
        safety_notes=_build_safety_notes(avoided_topic_matches, sensitive_topic_matches),
        suggested_caption=summary,
        suggested_cta=_resolve_cta(config.cta_preference),
        suggested_hashtags=_suggest_hashtags(transcript.language, combined_text),
        thumbnail_text=title[:80],
        speaker_ids=speaker_ids,
        scene_ids=scene_ids,
        hook_second=hook_second,
        main_point_second=main_point_second,
        punchline_second=punchline_second,
        retention_level=_retention_level(
            final_score=score.final,
            duration_seconds=duration_seconds,
            hook_second=hook_second,
            requires_context=requires_context,
            can_standalone=can_standalone,
        ),
        requires_context=requires_context,
        can_standalone=can_standalone,
        scores={
            "hook": components.hook,
            "conflict": components.conflict,
            "emotion": components.emotion,
            "novelty": components.novelty,
            "comment_potential": components.comment_potential,
            "base_viral_score": score.base,
            "final_viral_score": adjusted_final_score,
            "penalties": {
                "context": penalties.context,
                "weak_ending": penalties.weak_ending,
                "slow_start": penalties.slow_start,
                "duplicate": penalties.duplicate,
                "unsafe_or_misleading": penalties.unsafe_or_misleading,
                "cut_quality": penalties.cut_quality,
            },
        },
    )


def _score_text(hook_text: str, combined_text: str, *, hook_second: float, duration_seconds: float) -> ClipScoreComponents:
    lowered = combined_text.lower()
    emotion = 8.2 if any(token in lowered for token in ("marah", "shock", "takut", "sedih", "senang")) else 6.8
    conflict = 8.4 if any(token in lowered for token in ("tapi", "namun", "vs", "debat", "salah")) else 6.6
    novelty = 8.1 if any(token in lowered for token in ("rahasia", "jarang", "ternyata", "sebenarnya")) else 6.7
    comment_potential = 8.0 if any(token in lowered for token in ("menurut", "setuju", "enggak", "gimana")) else 6.9
    hook = 8.8 if _hook_is_strong(hook_text) else 6.7
    if hook_second > 1.5:
        hook -= 0.4
    if duration_seconds > 60:
        comment_potential -= 0.2
    return ClipScoreComponents(
        hook=hook,
        conflict=conflict,
        emotion=emotion,
        novelty=novelty,
        comment_potential=comment_potential,
    )


def _hook_is_strong(text: str) -> bool:
    lowered = text.lower()
    stripped = text.strip()
    if not stripped:
        return False
    if stripped.endswith("?"):
        return True
    if _looks_like_filler_opening(lowered):
        return False
    return any(
        pattern in lowered
        for pattern in (
            "?",
            "kenapa",
            "gimana",
            "kok",
            "masa",
            "rahasia",
            "salah",
            "jangan",
            "ternyata",
            "masalah",
            "bahaya",
            "krisis",
            "fatal",
            "pecah",
            "rusak",
            "naik",
            "turun",
            "kebanyakan",
            "padahal",
            "justru",
        )
    )


def _window_has_complete_idea(segments: list[TranscriptSegment]) -> bool:
    if not segments:
        return False
    if len(segments) == 1:
        return _is_natural_ending_segment(segments[0].text) and _hook_is_strong(segments[0].text)

    joined = " ".join(segment.text.strip().lower() for segment in segments)
    last_text = segments[-1].text.strip().lower()
    has_hook = _hook_is_strong(segments[0].text) or any(token in joined for token in ("tapi", "padahal", "jadi", "makanya"))
    has_main_point = any(token in joined for token in ("karena", "makanya", "artinya", "intinya", "jadi", "solusinya"))
    has_payoff = _is_natural_ending_segment(last_text) or any(
        phrase in last_text
        for phrase in ("itulah", "makanya", "jadi", "karena itu", "selesai", "intinya", "poinnya")
    )
    return has_hook and has_main_point and has_payoff and not _ending_needs_extension(last_text)


def _is_natural_ending_segment(text: str) -> bool:
    stripped = text.strip()
    return stripped.endswith(("!", "?", ".")) and len(stripped) >= 20


def _resolve_hook_second(segments: list[TranscriptSegment]) -> float:
    clip_start = segments[0].start_seconds
    for segment in segments:
        if _hook_is_strong(segment.text):
            return round(segment.start_seconds - clip_start, 2)
    return 0.0


def _resolve_main_point_second(segments: list[TranscriptSegment]) -> float:
    clip_start = segments[0].start_seconds
    for segment in segments:
        lowered = segment.text.strip().lower()
        if any(token in lowered for token in ("karena", "makanya", "artinya", "intinya", "solusinya", "poinnya")):
            return round(segment.start_seconds - clip_start, 2)
    if len(segments) >= 2:
        return round(segments[1].start_seconds - clip_start, 2)
    return 0.0


def _resolve_punchline_second(segments: list[TranscriptSegment]) -> float:
    clip_start = segments[0].start_seconds
    for segment in reversed(segments):
        lowered = segment.text.strip().lower()
        if _is_natural_ending_segment(segment.text) or any(
            token in lowered for token in ("makanya", "jadi", "itulah", "intinya", "poinnya")
        ):
            return round(segment.end_seconds - clip_start, 2)
    return round(segments[-1].end_seconds - clip_start, 2)


def _normalize_story_beats(
    *,
    hook_second: float,
    main_point_second: float,
    punchline_second: float,
    duration_seconds: float,
) -> tuple[float, float, float]:
    bounded_duration = max(0.01, round(duration_seconds, 2))
    normalized_hook = round(max(0.0, min(hook_second, bounded_duration)), 2)
    normalized_main_point = round(max(normalized_hook, min(main_point_second, bounded_duration)), 2)
    normalized_punchline = round(max(normalized_main_point, min(punchline_second, bounded_duration)), 2)
    return normalized_hook, normalized_main_point, normalized_punchline


def _requires_context(segments: list[TranscriptSegment]) -> bool:
    first_text = segments[0].text.strip().lower()
    full_text = " ".join(segment.text.strip().lower() for segment in segments)
    if len(segments) <= 1 and not _hook_is_strong(first_text):
        return True
    if _window_contains_internal_reset(segments):
        return True
    if any(phrase in first_text for phrase in ("seperti tadi", "lanjutan", "bagian ini", "itu tadi", "sebelumnya")):
        return True
    if not any(token in full_text for token in ("karena", "jadi", "makanya", "intinya", "solusinya")):
        return True
    return False


def _can_stand_alone(segments: list[TranscriptSegment]) -> bool:
    return _window_has_complete_idea(segments) and not _requires_context(segments)


def _retention_level(
    *,
    final_score: float,
    duration_seconds: float,
    hook_second: float,
    requires_context: bool,
    can_standalone: bool,
) -> str:
    if can_standalone and not requires_context and hook_second <= 1.2 and duration_seconds <= 45 and final_score >= 8.0:
        return "very_high"
    if can_standalone and hook_second <= 2.0 and duration_seconds <= 60 and final_score >= 7.4:
        return "high"
    if not requires_context and final_score >= 6.8:
        return "medium"
    return "low"


def _why_it_works(components: ClipScoreComponents) -> list[str]:
    reasons: list[str] = []
    if components.hook >= 8:
        reasons.append("Opens with a clear hook.")
    if components.conflict >= 8:
        reasons.append("Contains contrast or disagreement.")
    if components.comment_potential >= 7.5:
        reasons.append("Likely to trigger audience response.")
    if components.novelty >= 8:
        reasons.append("Carries a non-obvious angle.")
    return reasons or ["Contains a compact idea with a clear payoff."]


def _content_category(text: str) -> str:
    lowered = text.lower()
    if any(token in lowered for token in ("cerita", "dulu", "pernah", "waktu itu")):
        return "story"
    if any(token in lowered for token in ("lucu", "ketawa", "bercanda")):
        return "humor"
    if any(token in lowered for token in ("reaksi", "kaget", "shock")):
        return "reaction"
    if any(token in lowered for token in ("debat", "salah", "vs")):
        return "debate"
    if any(token in lowered for token in ("tips", "cara", "pelajaran", "insight")):
        return "insight"
    return "other"


def _build_title(text: str, *, hook_text: str, ending_text: str) -> str:
    candidates = _split_title_candidates(hook_text) + _split_title_candidates(text) + _split_title_candidates(ending_text)
    seen: set[str] = set()
    ranked: list[tuple[float, str]] = []
    for candidate in candidates:
        normalized = _normalize_title_candidate(candidate)
        if not normalized:
            continue
        lowered = normalized.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        ranked.append((_score_title_candidate(normalized), normalized))

    if not ranked:
        fallback = _truncate_title_words(_normalize_title_candidate(hook_text) or _normalize_title_candidate(text), max_words=9)
        return fallback or "Momen penting ini"

    ranked.sort(key=lambda item: (item[0], -len(item[1].split())), reverse=True)
    best = ranked[0][1]
    return _truncate_title_words(best, max_words=9)


def _suggest_hashtags(language: str, text: str) -> list[str]:
    base = ["#creatorstudio", "#shortclips"]
    if language.startswith("id"):
        base.append("#kontencreator")
    lowered = text.lower()
    if "marketing" in lowered:
        base.append("#marketing")
    if "bisnis" in lowered:
        base.append("#bisnis")
    return base[:5]


def _matching_terms(text: str, terms: tuple[str, ...]) -> tuple[str, ...]:
    lowered = text.lower()
    matches: list[str] = []
    for term in terms:
        normalized = term.strip().lower()
        if normalized and normalized in lowered:
            matches.append(term)
    return tuple(matches)


def _strategy_score_adjustment(
    *,
    preferred_topic_matches: tuple[str, ...],
    avoided_topic_matches: tuple[str, ...],
    sensitive_topic_matches: tuple[str, ...],
    can_standalone: bool,
    requires_context: bool,
) -> float:
    adjustment = 0.0
    if preferred_topic_matches:
        adjustment += min(0.45, 0.15 * len(preferred_topic_matches))
    if avoided_topic_matches:
        adjustment -= min(1.0, 0.35 * len(avoided_topic_matches))
    if sensitive_topic_matches:
        adjustment -= min(0.5, 0.2 * len(sensitive_topic_matches))
    if can_standalone and not requires_context:
        adjustment += 0.1
    return round(adjustment, 4)


def _apply_score_adjustment(score: float, adjustment: float) -> float:
    return round(max(0.0, min(10.0, score + adjustment)), 4)


def _build_safety_notes(
    avoided_topic_matches: tuple[str, ...],
    sensitive_topic_matches: tuple[str, ...],
) -> list[str]:
    notes: list[str] = []
    for topic in avoided_topic_matches:
        notes.append(f"Touches topic marked to avoid: {topic}.")
    for topic in sensitive_topic_matches:
        notes.append(f"Contains sensitive topic: {topic}.")
    return notes[:10]


def _resolve_cta(value: str | None) -> str:
    return value or "Watch until the end and share your take."


def _intersects(start_seconds: float, end_seconds: float, segments: Iterable[TranscriptSegment]) -> bool:
    for segment in segments:
        if segment.start_seconds < end_seconds and segment.end_seconds > start_seconds:
            return True
    return False


def _touches_silence(start_seconds: float, end_seconds: float, silences: list[SilenceBoundary]) -> bool:
    return any(
        abs(silence.start_seconds - start_seconds) <= 0.35 or abs(silence.end_seconds - end_seconds) <= 0.35
        for silence in silences
    )


def _normalize_start(start_seconds: float, scenes: list[SceneBoundary], silences: list[SilenceBoundary]) -> float:
    candidates = [start_seconds]
    candidates.extend(scene.start_seconds for scene in scenes if 0 <= start_seconds - scene.start_seconds <= 0.75)
    candidates.extend(silence.end_seconds for silence in silences if 0 <= start_seconds - silence.end_seconds <= 0.5)
    return min(candidates)


def _normalize_end(end_seconds: float, scenes: list[SceneBoundary], silences: list[SilenceBoundary]) -> float:
    candidates = [end_seconds]
    candidates.extend(scene.end_seconds for scene in scenes if 0 <= scene.end_seconds - end_seconds <= 0.75)
    candidates.extend(silence.start_seconds for silence in silences if 0 <= silence.start_seconds - end_seconds <= 0.5)
    return max(candidates)


def _extend_candidate_end_to_complete_thought(
    *,
    start_seconds: float,
    end_seconds: float,
    ending_text: str,
    transcript_segments: list[TranscriptSegment],
    maximum_duration_seconds: float | None,
) -> tuple[float, str]:
    if not transcript_segments:
        return end_seconds, ending_text

    normalized_ending = ending_text.strip()
    if not _ending_needs_extension(normalized_ending):
        return end_seconds, normalized_ending

    duration_ceiling = start_seconds + maximum_duration_seconds if maximum_duration_seconds and maximum_duration_seconds > 0 else None
    extension_window_seconds = 10.0

    last_index = -1
    for index, segment in enumerate(transcript_segments):
        if segment.start_seconds < (end_seconds + 0.12):
            last_index = index
            continue
        break

    if last_index < 0:
        return end_seconds, normalized_ending

    resolved_end = end_seconds
    resolved_ending = normalized_ending
    previous_segment = transcript_segments[last_index]
    for segment in transcript_segments[last_index + 1:]:
        if duration_ceiling is not None and segment.end_seconds > duration_ceiling + 0.05:
            break
        if segment.end_seconds - end_seconds > extension_window_seconds:
            break
        if _segments_have_large_gap(previous_segment, segment):
            break
        if _segment_starts_topic_reset(segment.text):
            break

        candidate_text = segment.text.strip()
        if not candidate_text:
            continue

        resolved_end = segment.end_seconds
        resolved_ending = candidate_text
        previous_segment = segment

        if not _ending_needs_extension(candidate_text) and _is_natural_ending_segment(candidate_text):
            return round(resolved_end, 2), resolved_ending

        if _is_natural_ending_segment(candidate_text) and (
            _segment_lands_explanatory_payoff(candidate_text)
            or (segment.end_seconds - end_seconds) >= 3.0
        ):
            return round(resolved_end, 2), resolved_ending

    return round(resolved_end, 2), resolved_ending


def _ending_needs_extension(text: str) -> bool:
    stripped = text.strip()
    if not stripped:
        return True
    if not _is_natural_ending_segment(stripped):
        return True

    lowered = stripped.lower()
    if lowered.endswith("..."):
        return True
    if _ends_with_dangling_connector(lowered):
        return True
    if _starts_with_continuation_connector(lowered):
        return True
    return False


def _starts_with_continuation_connector(text: str) -> bool:
    lowered = text.strip().lower().lstrip("\"'([{")
    return any(
        lowered.startswith(prefix)
        for prefix in (
            "dan ",
            "atau ",
            "karena ",
            "nah ",
            "terus ",
            "lalu ",
            "tapi ",
            "supaya ",
            "buat ",
            "biar ",
        )
    )


def _ends_with_dangling_connector(text: str) -> bool:
    lowered = text.strip().lower().rstrip(" -,:;.!?\"'()[]{}")
    tail = lowered.split()[-1] if lowered.split() else ""
    return tail in {
        "dan",
        "atau",
        "karena",
        "jadi",
        "makanya",
        "kalau",
        "supaya",
        "buat",
        "biar",
        "nah",
        "misalnya",
        "kayak",
        "gimana",
    }


def _segment_lands_explanatory_payoff(text: str) -> bool:
    lowered = text.strip().lower()
    return any(
        phrase in lowered
        for phrase in (
            "artinya",
            "makanya",
            "jadi",
            "intinya",
            "karena itu",
            "itulah",
            "makin",
            "supaya",
            "yang ngatur",
            "itu sebabnya",
        )
    )


def _overlap_ratio(left: CandidateAnalysis, right: CandidateAnalysis) -> float:
    overlap = max(0.0, min(left.end_seconds, right.end_seconds) - max(left.start_seconds, right.start_seconds))
    if overlap <= 0:
        return 0
    shorter = min(left.duration_seconds, right.duration_seconds)
    return overlap / shorter if shorter > 0 else 0


def _build_source_summary(candidates: list[CandidateAnalysis]) -> str:
    if not candidates:
        return "No viable clip candidates were produced from the supplied analysis inputs."
    combined = " ".join(candidate.summary.strip() for candidate in candidates if candidate.summary.strip())
    if not combined:
        return "Structured candidate analysis completed without a textual source summary."
    trimmed = combined[:500].strip()
    return trimmed if len(combined) <= 500 else f"{trimmed}..."


def _retention_priority(level: str) -> int:
    return {
        "very_high": 4,
        "high": 3,
        "medium": 2,
        "low": 1,
    }.get(level, 0)


def _normalize_strategy_terms(value: object) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    normalized: list[str] = []
    for item in value:
        if not isinstance(item, str):
            continue
        stripped = item.strip()
        if stripped:
            normalized.append(stripped)
    return tuple(normalized)


def _normalize_optional_text(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def _looks_like_filler_opening(text: str) -> bool:
    normalized = text.strip().lower()
    return any(
        normalized.startswith(prefix)
        for prefix in (
            "oke",
            "ok",
            "nah",
            "jadi",
            "halo",
            "hai",
            "teman-teman",
            "guys",
            "selamat",
            "kita bahas",
            "di video ini",
        )
    )


def _window_should_be_rejected(segments: list[TranscriptSegment]) -> bool:
    if not segments:
        return True
    return _window_contains_internal_reset(segments)


def _window_contains_internal_reset(segments: list[TranscriptSegment]) -> bool:
    if len(segments) <= 1:
        return False
    for previous_segment, current_segment in zip(segments, segments[1:]):
        if _segments_have_large_gap(previous_segment, current_segment):
            return True
        if _segment_starts_topic_reset(current_segment.text):
            return True
    return False


def _segments_have_large_gap(
    previous_segment: TranscriptSegment,
    current_segment: TranscriptSegment,
    *,
    threshold_seconds: float = 4.0,
) -> bool:
    return (current_segment.start_seconds - previous_segment.end_seconds) >= threshold_seconds


def _segment_starts_topic_reset(text: str) -> bool:
    normalized = " ".join(text.strip().lower().split())
    if not normalized:
        return False
    return any(
        normalized.startswith(prefix)
        for prefix in (
            "halo",
            "hai",
            "hello",
            "selamat datang",
            "welcome back",
            "balik lagi",
            "kembali lagi",
            "ketemu lagi",
            "jumpa lagi",
            "halo teman-teman",
            "teman-teman",
            "guys",
            "bro",
            "sobat",
            "podcast kita",
            "di podcast",
            "hari ini kita",
            "kali ini kita",
            "bersama gue",
            "bersama saya",
        )
    )


def _split_title_candidates(text: str) -> list[str]:
    normalized = text.replace("\n", " ").strip()
    if not normalized:
        return []
    parts: list[str] = []
    for chunk in normalized.replace("?", ".").replace("!", ".").split("."):
        for sub_chunk in chunk.split(","):
            stripped = sub_chunk.strip()
            if stripped:
                parts.append(stripped)
    return parts[:8]


def _normalize_title_candidate(text: str) -> str:
    normalized = " ".join(text.strip().split())
    normalized = normalized.strip(" -,:;.!?\"'()[]{}")
    normalized = _strip_leading_fillers(normalized)
    if not normalized:
        return ""
    words = normalized.split()
    if len(words) == 1 and words[0].lower() in {"oke", "ok", "nah", "jadi", "masa", "gitu"}:
        return ""
    return normalized


def _strip_leading_fillers(text: str) -> str:
    words = text.split()
    while words and words[0].lower().strip(".,!?") in {
        "oke",
        "ok",
        "nah",
        "jadi",
        "masa",
        "wow",
        "oh",
        "ya",
        "gitu",
        "ini",
    }:
        words = words[1:]
    return " ".join(words)


def _score_title_candidate(text: str) -> float:
    lowered = text.lower()
    words = text.split()
    score = 0.0
    if 3 <= len(words) <= 10:
        score += 2.5
    elif len(words) <= 12:
        score += 1.0
    if any(token in lowered for token in ("kenapa", "gimana", "kok", "bahaya", "krisis", "fatal", "naik", "turun")):
        score += 2.2
    if any(token in lowered for token in ("jangan", "salah", "ternyata", "padahal", "justru", "masalah")):
        score += 2.0
    if any(token in lowered for token in ("tekanan", "ginjal", "utang", "ekonomi", "organ", "pipa", "tensi")):
        score += 1.6
    if text.endswith("?"):
        score += 1.2
    if _looks_like_filler_opening(lowered):
        score -= 3.0
    if len(words) < 2:
        score -= 4.0
    return score


def _truncate_title_words(text: str, *, max_words: int) -> str:
    words = text.split()
    if len(words) <= max_words:
        return text
    return " ".join(words[:max_words]).rstrip(" -,:;")


def _text_similarity(left: CandidateAnalysis, right: CandidateAnalysis) -> float:
    left_terms = {term for term in left.summary.lower().split() if term}
    right_terms = {term for term in right.summary.lower().split() if term}
    if not left_terms or not right_terms:
        return 0.0
    intersection = len(left_terms & right_terms)
    union = len(left_terms | right_terms)
    return intersection / union if union > 0 else 0.0
