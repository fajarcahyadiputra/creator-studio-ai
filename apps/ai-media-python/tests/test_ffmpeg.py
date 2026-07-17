from pathlib import Path

import pytest

from app.media.ffmpeg import (
    build_clip_filter_graph,
    build_audio_extraction,
    build_clip_render_command,
    build_ffprobe_command,
    summarize_ffprobe_payload,
)
from app.media.face_detection import summarize_face_samples


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


def test_standard_portrait_layout_can_render_a_safe_bottom_headline_overlay() -> None:
    graph = build_clip_filter_graph(
        source_width=1920,
        source_height=1080,
        target_width=1080,
        target_height=1920,
        fps=30,
        subtitle_path=Path("/tmp/subtitle.ass"),
        layout_options={
            "standard_headline_enabled": True,
            "standard_headline_position": "BOTTOM",
            "standard_headline_files": [Path("/tmp/headline-1.txt"), Path("/tmp/headline-2.txt")],
        },
    )

    assert "drawbox=" in graph
    assert "color=0x61d6c5@0.96" in graph
    assert "drawtext=textfile='/tmp/headline-1.txt'" in graph
    assert graph.index("drawtext=textfile='/tmp/headline-1.txt'") < graph.index("subtitles='/tmp/subtitle.ass'")


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


def test_explicit_split_strategy_falls_back_to_single_face_tracking_without_visual_confirmation() -> None:
    command = build_clip_render_command(
        source=Path("source.mp4"),
        destination=Path("final.mp4"),
        start_seconds=0,
        duration_seconds=12,
        source_width=1920,
        source_height=1080,
        width=1080,
        height=1920,
        crop_strategy="SPLIT_SCREEN",
        layout_options={
            "split_frame_enabled": False,
            "clip_duration_seconds": 12.0,
            "face_layout_summary": {
                "single_face_anchor_ratio": 0.75,
                "sample_offsets_seconds": [0.5, 6.0, 11.5],
                "tracking_samples": [
                    {"sample_index": 0, "anchor_ratio": 0.72, "face_count": 1},
                    {"sample_index": 1, "anchor_ratio": 0.75, "face_count": 1},
                    {"sample_index": 2, "anchor_ratio": 0.78, "face_count": 1},
                ],
            },
        },
    )

    args = command.as_exec_args()
    assert "-filter_complex" not in args
    assert "vstack=inputs=2" not in " ".join(args)
    assert "between(t" in " ".join(args)


def test_split_render_is_used_only_after_two_faces_are_confirmed() -> None:
    command = build_clip_render_command(
        source=Path("source.mp4"),
        destination=Path("final.mp4"),
        start_seconds=0,
        duration_seconds=12,
        source_width=1920,
        source_height=1080,
        width=1080,
        height=1920,
        crop_strategy="AUTO_REFRAME",
        layout_options={
            "split_frame_enabled": True,
            "face_layout_summary": {
                "sample_offsets_seconds": [0.5, 6.0, 11.5],
                "sample_anchor_pairs": [
                    {"sample_index": 0, "face_count": 2, "primary_anchor_ratio": 0.25, "secondary_anchor_ratio": 0.75},
                    {"sample_index": 1, "face_count": 1, "primary_anchor_ratio": 0.26, "secondary_anchor_ratio": 0.26},
                    {"sample_index": 2, "face_count": 2, "primary_anchor_ratio": 0.24, "secondary_anchor_ratio": 0.76},
                ],
            },
        },
    )

    args = command.as_exec_args()
    assert "-filter_complex" in args
    assert "vstack=inputs=2" in " ".join(args)
    assert "enable='between(t" in " ".join(args)


def test_face_summary_rejects_single_or_transient_second_face_for_split() -> None:
    single_face = {"center_x_ratio": 0.72, "area": 8000}
    second_face = {"center_x_ratio": 0.24, "area": 7000}
    summary = summarize_face_samples(
        [
            [single_face],
            [single_face],
            [single_face, second_face],
            [single_face],
            [single_face],
        ]
    )

    assert summary["supports_split_frame"] is False
    assert summary["split_decision_reason"] == "single_face_only"
    assert summary["stable_multi_face_sample_count"] == 1


def test_face_summary_enables_split_for_two_spatially_distinct_stable_faces() -> None:
    left_face = {"center_x_ratio": 0.24, "area": 8000}
    right_face = {"center_x_ratio": 0.76, "area": 7800}
    summary = summarize_face_samples(
        [
            [left_face, right_face],
            [left_face, right_face],
            [left_face, right_face],
            [left_face],
            [left_face, right_face],
        ]
    )

    assert summary["supports_split_frame"] is True
    assert summary["split_decision_reason"] == "two_faces_stable"
    assert summary["split_confidence"] == pytest.approx(0.8)
