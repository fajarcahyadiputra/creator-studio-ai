from app.activities.external_source_materialization import (
    _build_source_format_selector,
    _build_ytdlp_options,
    _normalize_target_video_height,
)


def test_high_quality_targets_have_bounded_480p_fallback() -> None:
    selector = _build_source_format_selector(1080)

    assert "[height<=1080][height>=480]" in selector
    assert selector.split("/")[-1] == "best[height<=1080][height>=480]"


def test_low_quality_targets_are_exact() -> None:
    assert "[height<=480][height>=480]" in _build_source_format_selector(480)
    assert "[height<=360][height>=360]" in _build_source_format_selector(360)


def test_download_options_never_include_unbounded_best_fallback() -> None:
    options = _build_ytdlp_options(skip_download=False, target_video_height=720)

    assert options["format"].split("/")[-1] == "best[height<=720][height>=480]"
    assert "extractor_args" not in options


def test_android_vr_fallback_is_explicit() -> None:
    options = _build_ytdlp_options(
        skip_download=False,
        target_video_height=720,
        player_client="android_vr",
    )

    assert options["extractor_args"] == {"youtube": {"player_client": ["android_vr"]}}
    assert "[height<=720][height>=480]" in options["format"]


def test_target_video_height_is_validated() -> None:
    assert _normalize_target_video_height("720") == 720
