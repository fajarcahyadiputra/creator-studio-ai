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
    minimum_duration_seconds: int
    maximum_duration_seconds: int
    minimum_viral_score: float


def build_pipeline_config(input_snapshot: dict[str, object]) -> PipelineConfig:
    strategy = input_snapshot.get("strategy")
    if not isinstance(strategy, dict):
        raise ValueError("strategy is required")
    return PipelineConfig(
        desired_clip_count=int(strategy.get("desired_clip_count", 3)),
        minimum_duration_seconds=int(strategy.get("minimum_duration_seconds", 15)),
        maximum_duration_seconds=int(strategy.get("maximum_duration_seconds", 60)),
        minimum_viral_score=float(strategy.get("minimum_viral_score", 7)),
    )


def build_candidate_analyses(
    analysis_inputs: AnalysisInputs,
    config: PipelineConfig,
) -> list[CandidateAnalysis]:
    transcript = analysis_inputs.transcript
    windows = _build_segment_windows(transcript, config)
    candidates: list[CandidateAnalysis] = []
    for index, segments in enumerate(windows, start=1):
        candidate = _candidate_from_segments(
            index=index,
            transcript=transcript,
            segments=segments,
            scenes=analysis_inputs.scenes,
            silences=analysis_inputs.silences,
        )
        if candidate.scores["final_viral_score"] >= config.minimum_viral_score:
            candidates.append(candidate)
    normalized = normalize_candidates(candidates, analysis_inputs.scenes, analysis_inputs.silences)
    return deduplicate_and_rank(normalized, config.desired_clip_count)


def normalize_candidates(
    candidates: list[CandidateAnalysis],
    scenes: list[SceneBoundary],
    silences: list[SilenceBoundary],
) -> list[CandidateAnalysis]:
    normalized: list[CandidateAnalysis] = []
    for candidate in candidates:
        start_seconds = _normalize_start(candidate.start_seconds, scenes, silences)
        end_seconds = _normalize_end(candidate.end_seconds, scenes, silences)
        if end_seconds <= start_seconds:
            end_seconds = candidate.end_seconds
            start_seconds = candidate.start_seconds
        normalized.append(
            candidate.model_copy(
                update={
                    "start_seconds": round(start_seconds, 2),
                    "end_seconds": round(end_seconds, 2),
                    "duration_seconds": round(end_seconds - start_seconds, 2),
                }
            )
        )
    return normalized


def deduplicate_and_rank(candidates: list[CandidateAnalysis], desired_count: int) -> list[CandidateAnalysis]:
    ranked = sorted(candidates, key=lambda item: item.scores["final_viral_score"], reverse=True)
    selected: list[CandidateAnalysis] = []
    for candidate in ranked:
        if len(selected) >= desired_count:
            break
        if any(_overlap_ratio(candidate, existing) > 0.6 for existing in selected):
            continue
        selected.append(candidate)
    return selected


def build_output_summary(candidates: list[CandidateAnalysis], *, source_summary: str | None = None) -> dict[str, object]:
    resolved_source_summary = source_summary or _build_source_summary(candidates)
    return {
        "analysis_version": "2.0",
        "source_summary": resolved_source_summary,
        "candidate_count": len(candidates),
        "candidates": [candidate.model_dump(mode="json") for candidate in candidates],
    }


def _build_segment_windows(
    transcript: TranscriptDocument,
    config: PipelineConfig,
) -> list[list[TranscriptSegment]]:
    windows: list[list[TranscriptSegment]] = []
    current: list[TranscriptSegment] = []
    for segment in transcript.segments:
        current.append(segment)
        duration = current[-1].end_seconds - current[0].start_seconds
        if duration >= config.minimum_duration_seconds:
            windows.append(list(current))
            while current and duration > config.maximum_duration_seconds:
                current.pop(0)
                if current:
                    duration = current[-1].end_seconds - current[0].start_seconds
        if len(windows) >= config.desired_clip_count * 3:
            break
    return windows or [[transcript.segments[0]]]


def _candidate_from_segments(
    index: int,
    transcript: TranscriptDocument,
    segments: list[TranscriptSegment],
    scenes: list[SceneBoundary],
    silences: list[SilenceBoundary],
) -> CandidateAnalysis:
    combined_text = " ".join(segment.text.strip() for segment in segments)
    hook_text = segments[0].text.strip()
    ending_text = segments[-1].text.strip()
    components = _score_text(hook_text, combined_text)
    penalties = ClipPenalties(
        context=0 if len(segments) >= 2 else 0.6,
        weak_ending=0 if ending_text.endswith((".", "!", "?")) else 0.2,
        slow_start=0 if _hook_is_strong(hook_text) else 0.4,
        duplicate=0,
        unsafe_or_misleading=0,
        cut_quality=0.2 if _touches_silence(segments[0].start_seconds, segments[-1].end_seconds, silences) else 0,
    )
    score = calculate_viral_score(components, penalties)
    scene_ids = [scene.scene_id for scene in scenes if _intersects(scene.start_seconds, scene.end_seconds, segments)]
    speaker_ids = sorted({segment.speaker_label for segment in segments if segment.speaker_label})
    summary = combined_text[:300]
    title = _build_title(summary)
    return CandidateAnalysis(
        candidate_id=f"candidate-{index:02d}-{sha1(summary.encode('utf-8')).hexdigest()[:8]}",
        start_seconds=segments[0].start_seconds,
        end_seconds=segments[-1].end_seconds,
        duration_seconds=round(segments[-1].end_seconds - segments[0].start_seconds, 2),
        title=title,
        hook_text=hook_text,
        ending_text=ending_text,
        summary=summary,
        why_it_works=_why_it_works(components),
        content_category=_content_category(combined_text),
        context_complete=len(segments) >= 2,
        safety_notes=[],
        suggested_caption=summary,
        suggested_cta="Watch until the end and share your take.",
        suggested_hashtags=_suggest_hashtags(transcript.language, combined_text),
        thumbnail_text=title[:80],
        speaker_ids=speaker_ids,
        scene_ids=scene_ids,
        scores={
            "hook": components.hook,
            "conflict": components.conflict,
            "emotion": components.emotion,
            "novelty": components.novelty,
            "comment_potential": components.comment_potential,
            "base_viral_score": score.base,
            "final_viral_score": score.final,
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


def _score_text(hook_text: str, combined_text: str) -> ClipScoreComponents:
    lowered = combined_text.lower()
    emotion = 8.2 if any(token in lowered for token in ("marah", "shock", "takut", "sedih", "senang")) else 6.8
    conflict = 8.4 if any(token in lowered for token in ("tapi", "namun", "vs", "debat", "salah")) else 6.6
    novelty = 8.1 if any(token in lowered for token in ("rahasia", "jarang", "ternyata", "sebenarnya")) else 6.7
    comment_potential = 8.0 if any(token in lowered for token in ("menurut", "setuju", "enggak", "gimana")) else 6.9
    hook = 8.8 if _hook_is_strong(hook_text) else 6.7
    return ClipScoreComponents(
        hook=hook,
        conflict=conflict,
        emotion=emotion,
        novelty=novelty,
        comment_potential=comment_potential,
    )


def _hook_is_strong(text: str) -> bool:
    lowered = text.lower()
    return any(
        pattern in lowered
        for pattern in ("?", "kenapa", "rahasia", "salah", "jangan", "ternyata", "masalah", "kebanyakan")
    )


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


def _build_title(text: str) -> str:
    trimmed = text.strip().rstrip(".!?")
    if len(trimmed) <= 72:
        return trimmed
    return f"{trimmed[:69].rstrip()}..."


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
