from app.domain.clip_scoring import calculate_viral_score
from app.domain.contracts import ClipPenalties, ClipScoreComponents


def test_viral_score_formula_and_penalty_clamp() -> None:
    score = calculate_viral_score(
        ClipScoreComponents(hook=9.2, conflict=8.5, emotion=8.1, novelty=8.8, comment_potential=9.0),
        ClipPenalties(context=0.5, weak_ending=0.2),
    )
    assert score.base == 8.725
    assert score.total_penalty == 0.7
    assert score.final == 8.025


def test_viral_score_never_below_zero() -> None:
    score = calculate_viral_score(
        ClipScoreComponents(hook=1, conflict=1, emotion=1, novelty=1, comment_potential=1),
        ClipPenalties(
            context=2,
            weak_ending=1,
            slow_start=1,
            duplicate=1.5,
            unsafe_or_misleading=3,
            cut_quality=1,
        ),
    )
    assert score.final == 0
