from pathlib import Path

import pytest

from app.media.ffmpeg import (
    build_clip_filter_graph,
    build_audio_extraction,
    build_clip_render_command,
    build_ffprobe_command,
    summarize_ffprobe_payload,
)


def test_audio_command_uses_exec_arguments_not_shell_string() -> None:
    source = Path("/tmp/source file.mp4")
    destination = Path("/tmp/audio.wav")
    command = build_audio_extraction(source, destination)
    args = command.as_exec_args()
    assert args[0] == "ffmpeg"
    assert str(source) in args
    assert args[-1] == str(destination)


def test_audio_command_rejects_unknown_sample_rate() -> None:
    with pytest.raises(ValueError):
        build_audio_extraction(Path("a"), Path("b"), sample_rate=12345)


def test_ffprobe_command_uses_exec_arguments_not_shell_string() -> None:
    source = Path("/tmp/source file.mp4")
    command = build_ffprobe_command(source)
    args = command.as_exec_args()
    assert args[0] == "ffprobe"
    assert args[-1] == str(source)


def test_ffprobe_command_accepts_url_sources() -> None:
    command = build_ffprobe_command("http://minio:9000/signed-read-url")
    args = command.as_exec_args()
    assert args[0] == "ffprobe"
    assert args[-1] == "http://minio:9000/signed-read-url"


def test_ffprobe_summary_extracts_video_and_audio_metadata() -> None:
    summary = summarize_ffprobe_payload(
        {
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "h264",
                    "width": 1920,
                    "height": 1080,
                    "avg_frame_rate": "30000/1001",
                    "side_data_list": [{"rotation": 90}],
                },
                {
                    "codec_type": "audio",
                    "codec_name": "aac",
                    "sample_rate": "48000",
                },
            ],
            "format": {"duration": "65.4321"},
        }
    )

    assert summary.duration_ms == 65432
    assert summary.width == 1920
    assert summary.height == 1080
    assert summary.frame_rate == pytest.approx(29.97, abs=0.01)
    assert summary.audio_sample_rate == 48000
    assert summary.codec_name == "h264"
    assert summary.audio_codec_name == "aac"
    assert summary.rotation == 90
    assert summary.has_audio is True


def test_ffprobe_summary_requires_streams_list() -> None:
    with pytest.raises(ValueError):
        summarize_ffprobe_payload({"format": {"duration": "1.0"}})


def test_clip_render_command_uses_exec_arguments_not_shell_string() -> None:
    source = Path("/tmp/source file.mp4")
    destination = Path("/tmp/final.mp4")
    subtitle = Path("/tmp/subtitle.ass")
    command = build_clip_render_command(
        source=source,
        destination=destination,
        start_seconds=12.0,
        duration_seconds=18.5,
        source_width=1920,
        source_height=1080,
        width=1080,
        height=1920,
        fps=30,
        video_preset="medium",
        subtitle_path=subtitle,
    )

    args = command.as_exec_args()
    assert args[0] == "ffmpeg"
    assert str(source) in args
    assert str(destination) in args
    assert f"crop=608:1080:656:0,scale=1080:1920,fps=30,subtitles={subtitle}" in args


def test_clip_filter_graph_uses_center_crop_for_portrait_targets() -> None:
    graph = build_clip_filter_graph(
        source_width=1920,
        source_height=1080,
        target_width=1080,
        target_height=1920,
        fps=30,
        subtitle_path=None,
    )

    assert graph == "crop=608:1080:656:0,scale=1080:1920,fps=30"


def test_clip_render_command_rejects_invalid_duration() -> None:
    with pytest.raises(ValueError):
        build_clip_render_command(
            source=Path("source.mp4"),
            destination=Path("final.mp4"),
            start_seconds=0,
            duration_seconds=0,
            source_width=1920,
            source_height=1080,
            width=1080,
            height=1920,
        )
