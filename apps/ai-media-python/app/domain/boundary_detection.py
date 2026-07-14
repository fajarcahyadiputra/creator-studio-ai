from app.domain.contracts import AnalysisInputs, SceneBoundary, SilenceBoundary, TranscriptDocument


def enrich_analysis_inputs(
    analysis_inputs: AnalysisInputs,
    *,
    max_scene_duration_seconds: float = 12.0,
    min_silence_gap_seconds: float = 0.45,
) -> AnalysisInputs:
    scenes = analysis_inputs.scenes or build_scene_boundaries(
        analysis_inputs.transcript,
        max_scene_duration_seconds=max_scene_duration_seconds,
    )
    silences = analysis_inputs.silences or build_silence_boundaries(
        analysis_inputs.transcript,
        min_gap_seconds=min_silence_gap_seconds,
    )
    return analysis_inputs.model_copy(
        update={
            "scenes": scenes,
            "silences": silences,
        }
    )


def build_scene_boundaries(
    transcript: TranscriptDocument,
    *,
    max_scene_duration_seconds: float = 12.0,
) -> list[SceneBoundary]:
    if not transcript.segments:
        return []

    scenes: list[SceneBoundary] = []
    current_start = transcript.segments[0].start_seconds
    current_end = transcript.segments[0].end_seconds
    current_speaker = transcript.segments[0].speaker_label

    for segment in transcript.segments[1:]:
        speaker_changed = bool(current_speaker and segment.speaker_label and segment.speaker_label != current_speaker)
        duration_exceeded = (segment.end_seconds - current_start) >= max_scene_duration_seconds
        hard_sentence_break = _ends_scene(segment.text)

        if speaker_changed or duration_exceeded:
            _append_scene_boundary(scenes, current_start, current_end)
            current_start = segment.start_seconds

        current_end = segment.end_seconds
        current_speaker = segment.speaker_label

        if hard_sentence_break and (current_end - current_start) >= 4.0:
            _append_scene_boundary(scenes, current_start, current_end)
            current_start = current_end

    if current_end > current_start:
        _append_scene_boundary(scenes, current_start, current_end)

    return _merge_short_adjacent_scenes(scenes)


def build_silence_boundaries(
    transcript: TranscriptDocument,
    *,
    min_gap_seconds: float = 0.45,
) -> list[SilenceBoundary]:
    silences: list[SilenceBoundary] = []
    for previous, current in zip(transcript.segments, transcript.segments[1:]):
        gap = current.start_seconds - previous.end_seconds
        if gap >= min_gap_seconds:
            silences.append(
                SilenceBoundary(
                    silence_id=f"silence-{len(silences) + 1}",
                    start_seconds=round(previous.end_seconds, 2),
                    end_seconds=round(current.start_seconds, 2),
                )
            )
    return silences


def _merge_short_adjacent_scenes(scenes: list[SceneBoundary]) -> list[SceneBoundary]:
    if not scenes:
        return []

    merged: list[SceneBoundary] = [scenes[0]]
    for scene in scenes[1:]:
        previous = merged[-1]
        if (previous.end_seconds - previous.start_seconds) < 2.5:
            merged[-1] = SceneBoundary(
                scene_id=previous.scene_id,
                start_seconds=previous.start_seconds,
                end_seconds=scene.end_seconds,
            )
            continue
        merged.append(scene)

    return [
        SceneBoundary(
            scene_id=f"scene-{index}",
            start_seconds=scene.start_seconds,
            end_seconds=scene.end_seconds,
        )
        for index, scene in enumerate(merged, start=1)
    ]


def _append_scene_boundary(scenes: list[SceneBoundary], start_seconds: float, end_seconds: float) -> None:
    start_seconds = round(start_seconds, 2)
    end_seconds = round(end_seconds, 2)

    if end_seconds <= start_seconds:
        return

    if scenes:
        previous = scenes[-1]
        if previous.start_seconds == start_seconds and previous.end_seconds == end_seconds:
            return
        if start_seconds < previous.end_seconds:
            start_seconds = previous.end_seconds
            if end_seconds <= start_seconds:
                return

    scenes.append(
        SceneBoundary(
            scene_id=f"scene-{len(scenes) + 1}",
            start_seconds=start_seconds,
            end_seconds=end_seconds,
        )
    )


def _ends_scene(text: str) -> bool:
    stripped = text.strip()
    return stripped.endswith(("!", "?", ".")) and len(stripped) >= 24
