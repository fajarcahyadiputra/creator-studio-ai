from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from typing import Iterable

from app.domain.contracts import TranscriptSegment, TranscriptWord

MIN_EDIT_CONFIDENCE = 0.82
MIN_LONG_SILENCE_SECONDS = 1.1
SPEECH_EDGE_PADDING_SECONDS = 0.18
MAX_REMOVED_RATIO = 0.22
MIN_APPLIED_REMOVAL_SECONDS = 0.08

_SINGLE_FILLERS = {
    "aaa",
    "aa",
    "eee",
    "ee",
    "emm",
    "em",
    "hmm",
    "hm",
    "anu",
}
_FILLER_PHRASES = {
    ("apa", "namanya"),
    ("jadi", "gini"),
}
_NON_SPEECH_MARKERS = {
    "batuk",
    "cough",
    "breath",
    "napas",
    "noise",
    "mouth",
    "suara mulut",
}


@dataclass(frozen=True, slots=True)
class SpeechCleanupRemoval:
    start_seconds: float
    end_seconds: float
    reason: str
    confidence: float

    @property
    def duration_seconds(self) -> float:
        return max(0.0, self.end_seconds - self.start_seconds)


@dataclass(frozen=True, slots=True)
class SpeechCleanupTimelineSpan:
    source_start_seconds: float
    source_end_seconds: float
    output_start_seconds: float
    output_end_seconds: float

    @property
    def duration_seconds(self) -> float:
        return max(0.0, self.source_end_seconds - self.source_start_seconds)


@dataclass(frozen=True, slots=True)
class SpeechCleanupPlan:
    enabled: bool
    applied: bool
    clip_start_seconds: float
    source_duration_seconds: float
    output_duration_seconds: float
    removals: tuple[SpeechCleanupRemoval, ...]
    timeline: tuple[SpeechCleanupTimelineSpan, ...]

    def to_metadata(self) -> dict[str, object]:
        return {
            "enabled": self.enabled,
            "applied": self.applied,
            "source_duration_seconds": round(self.source_duration_seconds, 3),
            "output_duration_seconds": round(self.output_duration_seconds, 3),
            "removed_duration_seconds": round(
                self.source_duration_seconds - self.output_duration_seconds,
                3,
            ),
            "removal_count": len(self.removals),
            "removals": [
                {
                    "start_time": round(removal.start_seconds, 3),
                    "end_time": round(removal.end_seconds, 3),
                    "clip_start_time": round(
                        removal.start_seconds - self.clip_start_seconds,
                        3,
                    ),
                    "clip_end_time": round(
                        removal.end_seconds - self.clip_start_seconds,
                        3,
                    ),
                    "reason": removal.reason,
                    "confidence": round(removal.confidence, 3),
                }
                for removal in self.removals
            ],
            "final_timeline": [asdict(span) for span in self.timeline],
            "policy": {
                "minimum_confidence": MIN_EDIT_CONFIDENCE,
                "speech_edge_padding_ms": int(SPEECH_EDGE_PADDING_SECONDS * 1000),
                "maximum_removed_ratio": MAX_REMOVED_RATIO,
                "low_confidence_edits_skipped": True,
            },
        }


@dataclass(frozen=True, slots=True)
class _TimedWord:
    start_seconds: float
    end_seconds: float
    text: str
    normalized: str
    confidence: float


def build_speech_cleanup_plan(
    *,
    transcript_segments: Iterable[TranscriptSegment],
    clip_start_seconds: float,
    clip_duration_seconds: float,
    enabled: bool,
) -> SpeechCleanupPlan:
    clip_end_seconds = clip_start_seconds + clip_duration_seconds
    if not enabled:
        return _unchanged_plan(
            enabled=False,
            clip_start_seconds=clip_start_seconds,
            clip_duration_seconds=clip_duration_seconds,
        )

    words = _collect_words(
        transcript_segments,
        clip_start_seconds=clip_start_seconds,
        clip_end_seconds=clip_end_seconds,
    )
    proposed: list[SpeechCleanupRemoval] = []
    proposed.extend(
        _find_long_silences(
            words,
            clip_start_seconds=clip_start_seconds,
            clip_end_seconds=clip_end_seconds,
        )
    )
    proposed.extend(_find_safe_fillers(words))
    proposed.extend(_find_safe_repetitions(words))
    proposed.extend(
        _find_non_speech_segments(
            transcript_segments,
            clip_start_seconds=clip_start_seconds,
            clip_end_seconds=clip_end_seconds,
        )
    )

    removals = _select_safe_removals(
        proposed,
        clip_start_seconds=clip_start_seconds,
        clip_end_seconds=clip_end_seconds,
        clip_duration_seconds=clip_duration_seconds,
    )
    if not removals:
        return _unchanged_plan(
            enabled=True,
            clip_start_seconds=clip_start_seconds,
            clip_duration_seconds=clip_duration_seconds,
        )

    timeline = _build_timeline(
        removals,
        clip_start_seconds=clip_start_seconds,
        clip_end_seconds=clip_end_seconds,
    )
    output_duration = sum(span.duration_seconds for span in timeline)
    return SpeechCleanupPlan(
        enabled=True,
        applied=True,
        clip_start_seconds=clip_start_seconds,
        source_duration_seconds=clip_duration_seconds,
        output_duration_seconds=round(output_duration, 6),
        removals=tuple(removals),
        timeline=tuple(timeline),
    )


def remap_transcript_segments(
    transcript_segments: Iterable[TranscriptSegment],
    plan: SpeechCleanupPlan,
) -> list[TranscriptSegment]:
    if not plan.applied:
        return list(transcript_segments)

    remapped: list[TranscriptSegment] = []
    for segment in transcript_segments:
        mapped_words = [
            mapped
            for word in segment.words
            if (mapped := _remap_word(word, plan.timeline)) is not None
        ]
        if mapped_words:
            remapped.append(
                TranscriptSegment(
                    segment_id=f"{segment.segment_id}-clean",
                    start_seconds=mapped_words[0].start_seconds,
                    end_seconds=mapped_words[-1].end_seconds,
                    text=_join_word_text(word.text for word in mapped_words),
                    speaker_label=segment.speaker_label,
                    confidence=segment.confidence,
                    words=mapped_words,
                )
            )
            continue

        mapped_interval = _remap_interval(
            segment.start_seconds,
            segment.end_seconds,
            plan.timeline,
        )
        if mapped_interval is None:
            continue
        mapped_start, mapped_end = mapped_interval
        remapped.append(
            TranscriptSegment(
                segment_id=f"{segment.segment_id}-clean",
                start_seconds=mapped_start,
                end_seconds=mapped_end,
                text=segment.text,
                speaker_label=segment.speaker_label,
                confidence=segment.confidence,
                words=[],
            )
        )
    return remapped


def _unchanged_plan(
    *,
    enabled: bool,
    clip_start_seconds: float,
    clip_duration_seconds: float,
) -> SpeechCleanupPlan:
    clip_end_seconds = clip_start_seconds + clip_duration_seconds
    timeline = (
        SpeechCleanupTimelineSpan(
            source_start_seconds=clip_start_seconds,
            source_end_seconds=clip_end_seconds,
            output_start_seconds=0.0,
            output_end_seconds=clip_duration_seconds,
        ),
    )
    return SpeechCleanupPlan(
        enabled=enabled,
        applied=False,
        clip_start_seconds=clip_start_seconds,
        source_duration_seconds=clip_duration_seconds,
        output_duration_seconds=clip_duration_seconds,
        removals=(),
        timeline=timeline,
    )


def _collect_words(
    transcript_segments: Iterable[TranscriptSegment],
    *,
    clip_start_seconds: float,
    clip_end_seconds: float,
) -> list[_TimedWord]:
    words: list[_TimedWord] = []
    for segment in transcript_segments:
        for word in segment.words:
            if word.end_seconds <= clip_start_seconds or word.start_seconds >= clip_end_seconds:
                continue
            normalized = _normalize_token(word.text)
            if not normalized:
                continue
            words.append(
                _TimedWord(
                    start_seconds=max(clip_start_seconds, word.start_seconds),
                    end_seconds=min(clip_end_seconds, word.end_seconds),
                    text=word.text,
                    normalized=normalized,
                    confidence=word.confidence if word.confidence is not None else 0.9,
                )
            )
    return sorted(words, key=lambda word: (word.start_seconds, word.end_seconds))


def _find_long_silences(
    words: list[_TimedWord],
    *,
    clip_start_seconds: float,
    clip_end_seconds: float,
) -> list[SpeechCleanupRemoval]:
    if not words:
        return []
    boundaries = [
        (clip_start_seconds, words[0].start_seconds),
        *[
            (current.end_seconds, following.start_seconds)
            for current, following in zip(words, words[1:])
        ],
        (words[-1].end_seconds, clip_end_seconds),
    ]
    removals: list[SpeechCleanupRemoval] = []
    for gap_start, gap_end in boundaries:
        gap_duration = gap_end - gap_start
        if gap_duration < MIN_LONG_SILENCE_SECONDS:
            continue
        removal_start = gap_start + SPEECH_EDGE_PADDING_SECONDS
        removal_end = gap_end - SPEECH_EDGE_PADDING_SECONDS
        if removal_end - removal_start < MIN_APPLIED_REMOVAL_SECONDS:
            continue
        confidence = min(0.99, 0.86 + min(gap_duration - MIN_LONG_SILENCE_SECONDS, 1.3) * 0.08)
        removals.append(
            SpeechCleanupRemoval(
                start_seconds=removal_start,
                end_seconds=removal_end,
                reason="long_silence",
                confidence=confidence,
            )
        )
    return removals


def _find_safe_fillers(words: list[_TimedWord]) -> list[SpeechCleanupRemoval]:
    removals: list[SpeechCleanupRemoval] = []
    index = 0
    while index < len(words):
        match_size = 0
        if words[index].normalized in _SINGLE_FILLERS:
            match_size = 1
        else:
            for phrase in _FILLER_PHRASES:
                candidate = tuple(
                    word.normalized for word in words[index : index + len(phrase)]
                )
                if candidate == phrase:
                    match_size = len(phrase)
                    break
        if not match_size:
            index += 1
            continue

        first = words[index]
        last = words[index + match_size - 1]
        previous_end = words[index - 1].end_seconds if index > 0 else None
        next_start = (
            words[index + match_size].start_seconds
            if index + match_size < len(words)
            else None
        )
        left_gap = first.start_seconds - previous_end if previous_end is not None else 0.25
        right_gap = next_start - last.end_seconds if next_start is not None else 0.25
        confidence = min(word.confidence for word in words[index : index + match_size])
        if (
            confidence >= MIN_EDIT_CONFIDENCE
            and left_gap >= 0.08
            and right_gap >= 0.08
            and last.end_seconds - first.start_seconds <= 1.2
        ):
            removals.append(
                SpeechCleanupRemoval(
                    start_seconds=first.start_seconds,
                    end_seconds=last.end_seconds,
                    reason="filler_word",
                    confidence=confidence,
                )
            )
        index += max(match_size, 1)
    return removals


def _find_safe_repetitions(words: list[_TimedWord]) -> list[SpeechCleanupRemoval]:
    removals: list[SpeechCleanupRemoval] = []
    for index in range(1, len(words) - 1):
        previous = words[index - 1]
        current = words[index]
        following = words[index + 1]
        if current.normalized != previous.normalized or len(current.normalized) < 2:
            continue
        if (
            current.confidence >= 0.9
            and current.start_seconds - previous.end_seconds >= 0.06
            and following.start_seconds - current.end_seconds >= 0.08
            and current.end_seconds - current.start_seconds <= 0.8
        ):
            removals.append(
                SpeechCleanupRemoval(
                    start_seconds=current.start_seconds,
                    end_seconds=current.end_seconds,
                    reason="unintended_repetition",
                    confidence=current.confidence,
                )
            )
    return removals


def _find_non_speech_segments(
    transcript_segments: Iterable[TranscriptSegment],
    *,
    clip_start_seconds: float,
    clip_end_seconds: float,
) -> list[SpeechCleanupRemoval]:
    removals: list[SpeechCleanupRemoval] = []
    for segment in transcript_segments:
        normalized = _normalize_marker(segment.text)
        if normalized not in _NON_SPEECH_MARKERS:
            continue
        start = max(clip_start_seconds, segment.start_seconds)
        end = min(clip_end_seconds, segment.end_seconds)
        confidence = segment.confidence if segment.confidence is not None else 0.86
        if end > start and confidence >= MIN_EDIT_CONFIDENCE and end - start <= 1.5:
            removals.append(
                SpeechCleanupRemoval(
                    start_seconds=start,
                    end_seconds=end,
                    reason="non_speech_noise",
                    confidence=confidence,
                )
            )
    return removals


def _select_safe_removals(
    proposed: Iterable[SpeechCleanupRemoval],
    *,
    clip_start_seconds: float,
    clip_end_seconds: float,
    clip_duration_seconds: float,
) -> list[SpeechCleanupRemoval]:
    accepted = sorted(
        (
            removal
            for removal in proposed
            if removal.confidence >= MIN_EDIT_CONFIDENCE
            and removal.duration_seconds >= MIN_APPLIED_REMOVAL_SECONDS
        ),
        key=lambda removal: (removal.start_seconds, removal.end_seconds),
    )
    merged: list[SpeechCleanupRemoval] = []
    for removal in accepted:
        clamped = SpeechCleanupRemoval(
            start_seconds=max(clip_start_seconds, removal.start_seconds),
            end_seconds=min(clip_end_seconds, removal.end_seconds),
            reason=removal.reason,
            confidence=removal.confidence,
        )
        if clamped.duration_seconds < MIN_APPLIED_REMOVAL_SECONDS:
            continue
        if merged and clamped.start_seconds <= merged[-1].end_seconds + 0.03:
            previous = merged[-1]
            merged[-1] = SpeechCleanupRemoval(
                start_seconds=previous.start_seconds,
                end_seconds=max(previous.end_seconds, clamped.end_seconds),
                reason=(
                    previous.reason
                    if previous.reason == clamped.reason
                    else f"{previous.reason}+{clamped.reason}"
                ),
                confidence=min(previous.confidence, clamped.confidence),
            )
        else:
            merged.append(clamped)

    maximum_removed = clip_duration_seconds * MAX_REMOVED_RATIO
    selected: list[SpeechCleanupRemoval] = []
    removed_duration = 0.0
    for removal in sorted(merged, key=lambda item: (-item.confidence, item.start_seconds)):
        remaining_budget = maximum_removed - removed_duration
        if remaining_budget < MIN_APPLIED_REMOVAL_SECONDS:
            break
        if removal.duration_seconds > remaining_budget:
            if removal.reason != "long_silence":
                continue
            midpoint = (removal.start_seconds + removal.end_seconds) / 2
            half_budget = remaining_budget / 2
            removal = SpeechCleanupRemoval(
                start_seconds=midpoint - half_budget,
                end_seconds=midpoint + half_budget,
                reason=removal.reason,
                confidence=removal.confidence,
            )
        if removed_duration + removal.duration_seconds > maximum_removed + 1e-9:
            continue
        selected.append(removal)
        removed_duration += removal.duration_seconds
    return sorted(selected, key=lambda removal: removal.start_seconds)


def _build_timeline(
    removals: list[SpeechCleanupRemoval],
    *,
    clip_start_seconds: float,
    clip_end_seconds: float,
) -> list[SpeechCleanupTimelineSpan]:
    spans: list[SpeechCleanupTimelineSpan] = []
    source_cursor = clip_start_seconds
    output_cursor = 0.0
    for removal in removals:
        if removal.start_seconds > source_cursor:
            duration = removal.start_seconds - source_cursor
            spans.append(
                SpeechCleanupTimelineSpan(
                    source_start_seconds=source_cursor,
                    source_end_seconds=removal.start_seconds,
                    output_start_seconds=output_cursor,
                    output_end_seconds=output_cursor + duration,
                )
            )
            output_cursor += duration
        source_cursor = max(source_cursor, removal.end_seconds)
    if source_cursor < clip_end_seconds:
        duration = clip_end_seconds - source_cursor
        spans.append(
            SpeechCleanupTimelineSpan(
                source_start_seconds=source_cursor,
                source_end_seconds=clip_end_seconds,
                output_start_seconds=output_cursor,
                output_end_seconds=output_cursor + duration,
            )
        )
    return spans


def _remap_word(
    word: TranscriptWord,
    timeline: tuple[SpeechCleanupTimelineSpan, ...],
) -> TranscriptWord | None:
    mapped = _remap_interval(word.start_seconds, word.end_seconds, timeline)
    if mapped is None:
        return None
    start, end = mapped
    return TranscriptWord(
        start_seconds=start,
        end_seconds=end,
        text=word.text,
        confidence=word.confidence,
    )


def _remap_interval(
    start_seconds: float,
    end_seconds: float,
    timeline: tuple[SpeechCleanupTimelineSpan, ...],
) -> tuple[float, float] | None:
    for span in timeline:
        overlap_start = max(start_seconds, span.source_start_seconds)
        overlap_end = min(end_seconds, span.source_end_seconds)
        if overlap_end <= overlap_start:
            continue
        mapped_start = span.output_start_seconds + overlap_start - span.source_start_seconds
        mapped_end = span.output_start_seconds + overlap_end - span.source_start_seconds
        if mapped_end > mapped_start:
            return (round(mapped_start, 6), round(mapped_end, 6))
    return None


def _normalize_token(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.casefold())


def _normalize_marker(value: str) -> str:
    normalized = value.casefold().strip()
    return re.sub(r"^[\[(<{\s]+|[\])>}\s.!?,]+$", "", normalized)


def _join_word_text(words: Iterable[str]) -> str:
    text = " ".join(word.strip() for word in words if word.strip())
    return re.sub(r"\s+([,.;:!?])", r"\1", text).strip()
