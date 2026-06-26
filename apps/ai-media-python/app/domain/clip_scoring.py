from dataclasses import dataclass

from app.domain.contracts import ClipPenalties, ClipScoreComponents


@dataclass(frozen=True, slots=True)
class ViralScore:
    base: float
    total_penalty: float
    final: float


def calculate_viral_score(components: ClipScoreComponents, penalties: ClipPenalties) -> ViralScore:
    base = (
        components.hook * 0.30
        + components.conflict * 0.25
        + components.emotion * 0.20
        + components.novelty * 0.15
        + components.comment_potential * 0.10
    )
    total_penalty = sum(
        (
            penalties.context,
            penalties.weak_ending,
            penalties.slow_start,
            penalties.duplicate,
            penalties.unsafe_or_misleading,
            penalties.cut_quality,
        )
    )
    final = min(10.0, max(0.0, base - total_penalty))
    return ViralScore(round(base, 4), round(total_penalty, 4), round(final, 4))
