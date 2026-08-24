from pathlib import Path

from app.activities.external_source_materialization import (
    YOUTUBE_DOWNLOAD_STRATEGIES,
    _build_source_format_selector,
    _build_ytdlp_options,
    _is_youtube_access_denied_error,
    _is_youtube_authentication_error,
    _normalize_optional_url,
    _normalize_target_video_height,
    _prepare_ytdlp_cookie_file,
)


def test_high_quality_targets_have_bounded_480p_fallback() -> None:
    selector = _build_source_format_selector(1080)

    assert "[height<=1080][height>=480]" in selector
    assert selector.split("/")[0].endswith("[vcodec^=avc1]+bestaudio[ext=m4a]")
    assert selector.split("/")[-1] == "best[height<=1080][height>=480]"


def test_low_quality_targets_are_exact() -> None:
    assert "[height<=480][height>=480]" in _build_source_format_selector(480)
    assert "[height<=360][height>=360]" in _build_source_format_selector(360)


def test_download_options_never_include_unbounded_best_fallback() -> None:
    options = _build_ytdlp_options(skip_download=False, target_video_height=720)

    assert options["format"].split("/")[-1] == "best[height<=720][height>=480]"
    assert "extractor_args" not in options
    assert options["cachedir"] is False


def test_player_client_and_po_token_provider_are_applied() -> None:
    options = _build_ytdlp_options(
        skip_download=False,
        target_video_height=720,
        player_client="android_vr",
        po_token_provider_url="http://yt-dlp-pot-provider:4416/",
    )

    assert options["extractor_args"] == {
        "youtube": {"player_client": ["android_vr"]},
        "youtubepot-bgutilhttp": {"base_url": ["http://yt-dlp-pot-provider:4416"]},
    }
    assert "[height<=720][height>=480]" in options["format"]


def test_cookie_file_is_applied_to_metadata_and_download_options() -> None:
    cookie_file = Path("/run/secrets/yt-dlp/cookies.txt")

    metadata_options = _build_ytdlp_options(skip_download=True, cookie_file=cookie_file)
    download_options = _build_ytdlp_options(
        skip_download=False,
        target_video_height=720,
        cookie_file=cookie_file,
    )

    assert metadata_options["cookiefile"] == str(cookie_file)
    assert download_options["cookiefile"] == str(cookie_file)


def test_po_token_provider_is_applied_to_metadata_options() -> None:
    options = _build_ytdlp_options(
        skip_download=True,
        po_token_provider_url="http://yt-dlp-pot-provider:4416",
    )

    assert options["extractor_args"] == {
        "youtubepot-bgutilhttp": {"base_url": ["http://yt-dlp-pot-provider:4416"]},
    }


def test_youtube_bot_challenge_is_classified_as_authentication_error() -> None:
    error = RuntimeError(
        "Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for authentication."
    )

    assert _is_youtube_authentication_error(error) is True


def test_youtube_media_403_is_classified_as_access_denied() -> None:
    error = RuntimeError("ERROR: unable to download video data: HTTP Error 403: Forbidden")

    assert _is_youtube_access_denied_error(error) is True


def test_cookie_secret_is_copied_to_writable_activity_directory(tmp_path: Path) -> None:
    source = tmp_path / "secret" / "cookies.txt"
    source.parent.mkdir()
    source.write_text("# Netscape HTTP Cookie File\n", encoding="utf-8")
    workdir = tmp_path / "activity"
    workdir.mkdir()

    runtime_cookie = _prepare_ytdlp_cookie_file(source, workdir)

    assert runtime_cookie == workdir / "youtube-cookies.txt"
    assert runtime_cookie.read_text(encoding="utf-8") == source.read_text(encoding="utf-8")


def test_youtube_download_strategies_prefer_mweb_with_po_token() -> None:
    assert YOUTUBE_DOWNLOAD_STRATEGIES == (
        ("mweb-po", "mweb"),
        ("web-embedded", "web_embedded"),
        ("android-vr", "android_vr"),
        ("default", None),
    )


def test_optional_po_token_provider_url_is_normalized() -> None:
    assert _normalize_optional_url(" http://yt-dlp-pot-provider:4416/ ") == (
        "http://yt-dlp-pot-provider:4416"
    )
    assert _normalize_optional_url("") is None


def test_target_video_height_is_validated() -> None:
    assert _normalize_target_video_height("720") == 720
