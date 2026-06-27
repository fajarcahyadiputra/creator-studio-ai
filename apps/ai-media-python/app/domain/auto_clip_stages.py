from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class AutoClipStage:
    name: str
    weight: int


AUTO_CLIP_STAGES: tuple[AutoClipStage, ...] = (
    AutoClipStage("VALIDATING_SOURCE", 8),
    AutoClipStage("PROBING_MEDIA", 8),
    AutoClipStage("EXTRACTING_AUDIO", 8),
    AutoClipStage("TRANSCRIBING", 16),
    AutoClipStage("DETECTING_SCENES", 8),
    AutoClipStage("DETECTING_SILENCE", 6),
    AutoClipStage("ANALYZING_CLIP_CANDIDATES", 16),
    AutoClipStage("NORMALIZING_BOUNDARIES", 8),
    AutoClipStage("RANKING_AND_DEDUPLICATING", 6),
    AutoClipStage("GENERATING_PREVIEWS", 4),
    AutoClipStage("REFRAMING", 2),
    AutoClipStage("GENERATING_SUBTITLES", 2),
    AutoClipStage("RENDERING_FINAL_CLIPS", 2),
    AutoClipStage("QUALITY_CHECK", 2),
    AutoClipStage("GENERATING_METADATA", 2),
    AutoClipStage("UPLOADING_OUTPUTS", 2),
)

STAGE_WEIGHTS = {stage.name: stage.weight for stage in AUTO_CLIP_STAGES}
TOTAL_STAGE_WEIGHT = sum(STAGE_WEIGHTS.values())


def compute_overall_progress(stage_name: str, stage_progress: int) -> int:
    bounded_stage_progress = max(0, min(100, stage_progress))
    completed_weight = 0
    for stage in AUTO_CLIP_STAGES:
        if stage.name == stage_name:
            in_stage = stage.weight * bounded_stage_progress / 100
            return min(100, round((completed_weight + in_stage) / TOTAL_STAGE_WEIGHT * 100))
        completed_weight += stage.weight
    raise KeyError(f"Unknown auto clipping stage: {stage_name}")
