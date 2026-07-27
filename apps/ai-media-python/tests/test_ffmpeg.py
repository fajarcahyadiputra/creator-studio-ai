from pathlib import Path

import numpy as np
import pytest

from app.media.ffmpeg import (
    _build_active_speaker_crop_filter,
    _build_split_enable_expression,
    _build_temporal_tracking_crop_filter,
    build_clip_filter_graph,
    build_audio_extraction,
    build_clip_render_command,
    build_ffprobe_command,
    build_timeline_cleanup_command,
    summarize_ffprobe_payload,
)
from app.media.face_detection import (
    _annotate_conversation_layout_samples,
    _apply_active_tracking_quality_gate,
    _content_density_score,
    _stabilize_active_face_samples,
    apply_active_speaker_tracking,
    detect_faces_in_image,
    summarize_face_samples,
)


def test_content_density_detects_text_like_horizontal_bands() -> None:
    blank = np.zeros((360, 640), dtype=np.uint8)
    text_like = blank.copy()
    for y in range(60, 300, 40):
        text_like[y : y + 5, 80:560] = 255

    assert _content_density_score(blank) == 0.0
    assert _content_density_score(text_like) >= 0.08


def test_content_aware_layout_preserves_full_horizontal_frame() -> None:
    graph = build_clip_filter_graph(
        source_width=1920,
        source_height=1080,
        target_width=1080,
        target_height=1920,
        fps=30,
        crop_strategy="SMART_SPEAKER",
        layout_options={"content_aware_layout": True},
    )

    assert "force_original_aspect_ratio=decrease" in graph
    assert "pad=1080:1920" in graph
    assert "crop=" not in graph


def test_yunet_is_primary_when_it_detects_a_face(monkeypatch, tmp_path: Path) -> None:
    from app.media import face_detection

    expected = {
        "x": 200,
        "y": 100,
        "width": 120,
        "height": 150,
        "center_x": 260.0,
        "center_x_ratio": 0.4062,
        "area": 18000,
        "image_width": 640,
        "image_height": 360,
        "detector_pass": 1,
        "detector": "yunet",
        "confidence": 0.91,
    }
    monkeypatch.setattr(face_detection.cv2, "imread", lambda _path: np.zeros((360, 640, 3), dtype=np.uint8))
    monkeypatch.setattr(face_detection, "_detect_faces_with_yunet", lambda *_args, **_kwargs: [expected])

    result = detect_faces_in_image(tmp_path / "frame.jpg", yunet_model_path="/models/face/model.onnx")

    assert result == [expected]
    assert all(face["detector"] == "yunet" for face in result)


def test_audio_command_uses_exec_arguments_not_shell_string() -> None:
    source = Path("/tmp/source file.mp4")
    destination = Path("/tmp/audio.wav")
    command = build_audio_extraction(source, destination)
    args = command.as_exec_args()
    assert args[0] == "ffmpeg"
    assert str(source) in args
    assert args[-1] == str(destination)


def test_timeline_cleanup_command_trims_and_concatenates_kept_intervals() -> None:
    command = build_timeline_cleanup_command(
        source="/tmp/source.mp4",
        destination="/tmp/cleaned.mp4",
        keep_intervals=[(2.0, 5.0), (6.0, 8.5)],
    )
    arguments = command.as_exec_args()
    filter_graph = arguments[arguments.index("-filter_complex") + 1]

    assert "trim=start=2.000000:end=5.000000" in filter_graph
    assert "atrim=start=6.000000:end=8.500000" in filter_graph
    assert "concat=n=2:v=1:a=1[vout][aout]" in filter_graph
    assert arguments[-1] == "/tmp/cleaned.mp4"


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

    assert graph == "setpts=PTS-STARTPTS,crop=608:1080:656:0,scale=1080:1920,fps=30"


def test_active_speaker_crop_moves_early_with_a_short_smooth_transition() -> None:
    crop_filter = _build_active_speaker_crop_filter(
        source_width=1920,
        source_height=1080,
        target_width=1080,
        target_height=1920,
        layout_options={
            "active_speaker_strategy": {
                "available": True,
                "speaker_order": ["A", "B"],
                "speaker_anchor_ratios": {"A": 0.25, "B": 0.75},
                "transition_seconds": 0.16,
                "windows": [
                    {"speaker_label": "A", "start_seconds": 0.0, "end_seconds": 1.8},
                    {"speaker_label": "B", "start_seconds": 1.8, "end_seconds": 5.0},
                ],
            },
            "face_layout_summary": {"left_anchor_ratio": 0.25, "right_anchor_ratio": 0.75},
        },
    )

    assert crop_filter is not None
    assert "clip((t-1.800)/0.160\\,0\\,1)" in crop_filter
    assert "if(lt(t" not in crop_filter
    assert "between(t" not in crop_filter


def test_active_speaker_crop_keeps_ffmpeg_expression_flat_for_many_switches() -> None:
    windows = [
        {
            "speaker_label": "A" if index % 2 == 0 else "B",
            "start_seconds": index * 0.2,
            "end_seconds": (index + 1) * 0.2,
        }
        for index in range(405)
    ]
    crop_filter = _build_active_speaker_crop_filter(
        source_width=1920,
        source_height=1080,
        target_width=1080,
        target_height=1920,
        layout_options={
            "active_speaker_strategy": {
                "available": True,
                "speaker_order": ["A", "B"],
                "speaker_anchor_ratios": {"A": 0.25, "B": 0.75},
                "transition_seconds": 0.16,
                "windows": windows,
            },
            "face_layout_summary": {"left_anchor_ratio": 0.25, "right_anchor_ratio": 0.75},
        },
    )

    assert crop_filter is not None
    assert "if(lt(t" not in crop_filter
    assert 1 <= crop_filter.count("clip((t-") <= 80
    assert "clip((t-80.800)/0.160\\,0\\,1)" in crop_filter
    assert len(crop_filter) < 3_500


def test_active_face_tracking_enforces_minimum_hold_before_strong_switch() -> None:
    samples = _stabilize_active_face_samples(
        [
            {
                "sample_index": 0,
                "anchor_ratio": 0.24,
                "face_count": 2,
                "motion_score": 3.0,
                "motion_confidence": 0.4,
                "offset_seconds": 0.0,
            },
            {
                "sample_index": 1,
                "anchor_ratio": 0.76,
                "face_count": 2,
                "motion_score": 5.0,
                "motion_confidence": 0.5,
                "offset_seconds": 0.6,
            },
            {
                "sample_index": 2,
                "anchor_ratio": 0.76,
                "face_count": 2,
                "motion_score": 5.0,
                "motion_confidence": 0.5,
                "offset_seconds": 1.3,
            },
        ]
    )

    assert samples[0]["anchor_ratio"] == 0.24
    assert samples[1]["anchor_ratio"] == 0.24
    assert samples[1]["selection_source"] == "hold"
    assert samples[2]["anchor_ratio"] == 0.76
    assert samples[2]["selection_source"] == "strong_mouth_motion"


def test_active_face_tracking_does_not_lock_to_a_listener_during_opening_silence() -> None:
    samples = _stabilize_active_face_samples(
        [
            {
                "offset_seconds": 0.0,
                "anchor_ratio": 0.2,
                "face_count": 1,
                "motion_score": 8.0,
                "motion_confidence": 1.0,
                "speech_active": False,
            },
            {
                "offset_seconds": 0.4,
                "anchor_ratio": 0.8,
                "face_count": 1,
                "motion_score": 8.0,
                "motion_confidence": 1.0,
                "speech_active": True,
            },
        ]
    )

    assert samples[0]["anchor_ratio"] == 0.8
    assert samples[0]["selection_source"] == "leading_face_backfill"
    assert samples[1]["anchor_ratio"] == 0.8


def test_active_face_tracking_waits_for_mouth_evidence_when_multiple_faces_are_visible() -> None:
    samples = _stabilize_active_face_samples(
        [
            {
                "offset_seconds": 0.0,
                "anchor_ratio": 0.2,
                "face_count": 2,
                "motion_score": 0.0,
                "motion_confidence": 0.0,
                "speech_active": True,
            },
            {
                "offset_seconds": 0.33,
                "anchor_ratio": 0.8,
                "face_count": 2,
                "motion_score": 3.0,
                "motion_confidence": 0.4,
                "speech_active": True,
            },
        ]
    )

    assert samples[0]["anchor_ratio"] == 0.8
    assert samples[0]["selection_source"] == "leading_face_backfill"
    assert samples[1]["anchor_ratio"] == 0.8


def test_active_tracking_quality_gate_replaces_edge_clipped_framing() -> None:
    samples = _apply_active_tracking_quality_gate(
        [
            {
                "offset_seconds": 0.0,
                "anchor_ratio": 0.08,
                "face_left_ratio": 0.0,
                "face_right_ratio": 0.16,
                "active_speaker_count": 1,
            },
            {
                "offset_seconds": 0.33,
                "anchor_ratio": 0.55,
                "face_left_ratio": 0.45,
                "face_right_ratio": 0.65,
                "active_speaker_count": 1,
            },
        ]
    )

    assert samples[-1]["tracking_quality"]["passed"] is False
    assert samples[-1]["tracking_quality"]["fallback_applied"] is True
    assert all(sample["anchor_ratio"] == 0.55 for sample in samples)


def test_active_face_tracking_backfills_opening_only_from_first_face() -> None:
    samples = _stabilize_active_face_samples(
        [
            {
                "sample_index": 0,
                "anchor_ratio": None,
                "face_count": 0,
                "motion_score": 0.0,
                "motion_confidence": 0.0,
            },
            {
                "sample_index": 1,
                "anchor_ratio": None,
                "face_count": 0,
                "motion_score": 0.0,
                "motion_confidence": 0.0,
            },
            {
                "sample_index": 2,
                "anchor_ratio": 0.72,
                "face_left_ratio": 0.64,
                "face_right_ratio": 0.80,
                "face_count": 1,
                "motion_score": 0.0,
                "motion_confidence": 0.0,
            },
        ]
    )

    assert [sample["anchor_ratio"] for sample in samples] == [0.72, 0.72, 0.72]
    assert samples[0]["selection_source"] == "leading_face_backfill"
    assert samples[0]["face_left_ratio"] == 0.64
    assert samples[0]["face_right_ratio"] == 0.80


def test_active_face_tracking_requires_confirmation_for_ambiguous_switch() -> None:
    samples = _stabilize_active_face_samples(
        [
            {
                "sample_index": 0,
                "anchor_ratio": 0.25,
                "face_count": 2,
                "motion_score": 3.0,
                "motion_confidence": 0.4,
                "offset_seconds": 0.0,
            },
            {
                "sample_index": 1,
                "anchor_ratio": 0.75,
                "face_count": 2,
                "motion_score": 1.5,
                "motion_confidence": 0.2,
                "offset_seconds": 1.3,
            },
            {
                "sample_index": 2,
                "anchor_ratio": 0.74,
                "face_count": 2,
                "motion_score": 1.6,
                "motion_confidence": 0.2,
                "offset_seconds": 2.0,
            },
        ]
    )

    assert samples[1]["anchor_ratio"] == 0.25
    assert samples[2]["anchor_ratio"] == 0.74
    assert samples[2]["selection_source"] == "confirmed_mouth_motion"


def test_active_face_tracking_holds_previous_face_when_voice_confidence_is_low() -> None:
    samples = _stabilize_active_face_samples(
        [
            {
                "sample_index": 0,
                "offset_seconds": 0.0,
                "anchor_ratio": 0.22,
                "face_count": 2,
                "motion_score": 3.0,
                "motion_confidence": 0.4,
            },
            {
                "sample_index": 1,
                "offset_seconds": 2.0,
                "anchor_ratio": 0.78,
                "face_count": 2,
                "motion_score": 1.2,
                "motion_confidence": 0.05,
            },
        ]
    )

    assert samples[1]["anchor_ratio"] == 0.22
    assert samples[1]["selection_source"] == "hold"


def test_ambiguous_active_face_switch_keeps_matching_face_bounds() -> None:
    samples = _stabilize_active_face_samples(
        [
            {
                "sample_index": 0,
                "anchor_ratio": 0.22,
                "face_left_ratio": 0.16,
                "face_right_ratio": 0.28,
                "face_count": 2,
                "motion_score": 3.0,
                "motion_confidence": 0.4,
            },
            {
                "sample_index": 1,
                "anchor_ratio": 0.78,
                "face_left_ratio": 0.72,
                "face_right_ratio": 0.84,
                "face_count": 2,
                "motion_score": 1.0,
                "motion_confidence": 0.05,
            },
        ]
    )

    assert samples[1]["anchor_ratio"] == 0.22
    assert samples[1]["face_left_ratio"] == 0.16
    assert samples[1]["face_right_ratio"] == 0.28


def test_temporal_face_crop_uses_face_bounds_near_frame_edge() -> None:
    crop_filter = _build_temporal_tracking_crop_filter(
        source_width=1920,
        source_height=1080,
        target_width=1080,
        target_height=1920,
        tracking_samples=[
            {
                "anchor_ratio": 0.88,
                "face_left_ratio": 0.79,
                "face_right_ratio": 0.97,
            }
        ],
        sample_offsets=[0.5],
        duration_seconds=5.0,
    )

    assert crop_filter is not None
    # The crop is clamped to the right source edge and keeps the detected face
    # inside the frame instead of blindly centering on an impossible position.
    assert "crop=608:1080:1312:0" in crop_filter


def test_temporal_face_crop_uses_bounds_from_each_matching_sample() -> None:
    crop_filter = _build_temporal_tracking_crop_filter(
        source_width=1920,
        source_height=1080,
        target_width=1080,
        target_height=1920,
        tracking_samples=[
            {
                "anchor_ratio": 0.18,
                "face_left_ratio": 0.10,
                "face_right_ratio": 0.26,
            },
            {
                "anchor_ratio": 0.82,
                "face_left_ratio": 0.74,
                "face_right_ratio": 0.90,
            },
        ],
        sample_offsets=[0.0, 1.0],
        duration_seconds=2.0,
    )

    assert crop_filter is not None
    # A different crop state must be produced for each timestamp. Previously
    # both timestamps accidentally reused the final sample's face bounds.
    assert "42" in crop_filter
    assert "1270" in crop_filter
    assert "if(lt(t" not in crop_filter
    assert "clip((t-0.320)/0.160\\,0\\,1)" in crop_filter


def test_active_speaker_without_face_evidence_preserves_complete_source_frame() -> None:
    graph = build_clip_filter_graph(
        source_width=1920,
        source_height=1080,
        target_width=1080,
        target_height=1920,
        fps=30,
        crop_strategy="ACTIVE_SPEAKER",
        layout_options={
            "crop_strategy": "ACTIVE_SPEAKER",
            "face_layout_summary": {
                "valid_face_sample_count": 0,
                "tracking_samples": [],
            },
        },
    )

    assert "force_original_aspect_ratio=decrease" in graph
    assert "pad=1080:1920" in graph
    assert "crop=" not in graph


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
    assert "enable='between(t\\,0\\,3.500)'" in graph
    assert "drawtext=text='" not in graph
    assert graph.index("drawtext=textfile='/tmp/headline-1.txt'") < graph.index("subtitles='/tmp/subtitle.ass'")


def test_standard_portrait_layout_renders_all_four_full_title_lines() -> None:
    graph = build_clip_filter_graph(
        source_width=1920,
        source_height=1080,
        target_width=1080,
        target_height=1920,
        fps=30,
        layout_options={
            "standard_headline_enabled": True,
            "standard_headline_position": "TOP",
            "standard_headline_files": [
                Path("/tmp/headline-1.txt"),
                Path("/tmp/headline-2.txt"),
                Path("/tmp/headline-3.txt"),
                Path("/tmp/headline-4.txt"),
            ],
            "standard_headline_duration_seconds": 4.8,
        },
    )

    assert "drawtext=textfile='/tmp/headline-4.txt'" in graph
    assert "fontsize=44" in graph
    assert "enable='between(t\\,0\\,4.800)'" in graph


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
    assert "clip((t-" in " ".join(args)


def test_smart_speaker_render_switches_between_single_and_two_active_speakers() -> None:
    command = build_clip_render_command(
        source=Path("source.mp4"),
        destination=Path("final.mp4"),
        start_seconds=0,
        duration_seconds=12,
        source_width=1920,
        source_height=1080,
        width=1080,
        height=1920,
        crop_strategy="SMART_SPEAKER",
        layout_options={
            "crop_strategy": "SMART_SPEAKER",
            "split_frame_enabled": True,
            "face_layout_summary": {
                "adaptive_panel_count": 2,
                "subject_anchor_ratios": [0.25, 0.75],
                "sample_offsets_seconds": [0.5, 6.0, 11.5],
                "sample_anchor_pairs": [
                    {"sample_index": 0, "active_speaker_count": 2, "subject_anchor_ratios": [0.25, 0.75]},
                    {"sample_index": 1, "active_speaker_count": 1, "subject_anchor_ratios": [0.26]},
                    {"sample_index": 2, "active_speaker_count": 2, "subject_anchor_ratios": [0.24, 0.76]},
                ],
            },
        },
    )

    args = command.as_exec_args()
    assert "-filter_complex" in args
    assert "[layout_2]" in " ".join(args)
    assert "enable='between(t" in " ".join(args)


def test_smart_speaker_single_speaker_fallback_fills_portrait_canvas() -> None:
    command = build_clip_render_command(
        source=Path("source.mp4"),
        destination=Path("final.mp4"),
        start_seconds=0,
        duration_seconds=12,
        source_width=1920,
        source_height=1080,
        width=1080,
        height=1920,
        crop_strategy="SMART_SPEAKER",
        layout_options={
            "crop_strategy": "SMART_SPEAKER",
            "split_frame_enabled": False,
            "face_layout_summary": {
                "valid_face_sample_count": 0,
                "active_face_tracking_samples": [],
            },
        },
    )

    graph = " ".join(command.as_exec_args())
    assert "setpts=PTS-STARTPTS" in graph
    assert "crop=608:1080:656:0" in graph
    assert "force_original_aspect_ratio=decrease" not in graph
    assert "pad=1080:1920" not in graph


def test_smart_speaker_render_caps_adaptive_grid_at_four_active_speakers() -> None:
    anchors = [0.12, 0.37, 0.63, 0.88]
    command = build_clip_render_command(
        source=Path("source.mp4"),
        destination=Path("final.mp4"),
        start_seconds=0,
        duration_seconds=10,
        source_width=1920,
        source_height=1080,
        width=1080,
        height=1920,
        crop_strategy="SMART_SPEAKER",
        layout_options={
            "crop_strategy": "SMART_SPEAKER",
            "split_frame_enabled": True,
            "face_layout_summary": {
                "adaptive_panel_count": 4,
                "subject_anchor_ratios": anchors,
                "sample_offsets_seconds": [0.5, 5.0, 9.5],
                "sample_anchor_pairs": [
                    {"sample_index": index, "active_speaker_count": 4, "subject_anchor_ratios": anchors}
                    for index in range(3)
                ],
            },
        },
    )

    graph = " ".join(command.as_exec_args())
    assert "[layout_2]" in graph
    assert "[layout_3]" in graph
    assert "[layout_4]" in graph
    assert "panel_5" not in graph


def test_adaptive_split_does_not_leak_into_adjacent_single_face_samples() -> None:
    expression = _build_split_enable_expression(
        layout_options={
            "face_layout_summary": {
                "sample_offsets_seconds": [0.5, 1.5, 2.5],
                "sample_anchor_pairs": [
                    {"active_speaker_count": 2, "subject_anchor_ratios": [0.25, 0.75], "split_qualified": True},
                    {"active_speaker_count": 1, "subject_anchor_ratios": [0.25], "split_qualified": False},
                    {"active_speaker_count": 1, "subject_anchor_ratios": [0.25], "split_qualified": False},
                ],
            }
        },
        duration_seconds=3.0,
        minimum_face_count=2,
    )

    assert expression == "between(t\\,0.000\\,1.000)"


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
    assert summary["split_decision_reason"] == "two_faces_transient"
    assert summary["stable_multi_face_sample_count"] == 1
    assert summary["valid_face_sample_count"] == 5


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
    assert summary["adaptive_panel_count"] == 2
    assert summary["split_decision_reason"] == "two_faces_stable"
    assert summary["split_confidence"] == pytest.approx(0.6)


def test_face_summary_caps_adaptive_layout_at_four_distinct_faces() -> None:
    faces = [
        {"center_x_ratio": ratio, "area": 8000 - index}
        for index, ratio in enumerate([0.08, 0.29, 0.51, 0.73, 0.92])
    ]
    summary = summarize_face_samples([faces, faces, faces, faces])

    assert summary["adaptive_panel_count"] == 4
    assert len(summary["subject_anchor_ratios"]) == 4


def test_face_summary_rejects_edge_clipped_face_from_tracking_and_split() -> None:
    edge_face = {
        "x": 0,
        "y": 80,
        "width": 90,
        "height": 100,
        "center_x": 45,
        "center_x_ratio": 0.0469,
        "image_width": 960,
        "image_height": 540,
        "area": 9000,
    }
    valid_face = {
        "x": 620,
        "y": 80,
        "width": 90,
        "height": 100,
        "center_x": 665,
        "center_x_ratio": 0.6927,
        "image_width": 960,
        "image_height": 540,
        "area": 9000,
    }

    summary = summarize_face_samples([[edge_face, valid_face], [edge_face, valid_face]])

    assert summary["max_face_count"] == 1
    assert summary["supports_split_frame"] is False
    assert summary["tracking_samples"][0]["anchor_ratio"] == pytest.approx(0.6927)


def test_face_summary_requires_neighbour_confirmation_before_split() -> None:
    left_face = {"center_x_ratio": 0.24, "area": 8000}
    right_face = {"center_x_ratio": 0.76, "area": 7800}
    summary = summarize_face_samples(
        [[left_face], [left_face, right_face], [left_face], [left_face]]
    )

    assert summary["sample_anchor_pairs"][1]["split_qualified"] is False
    assert summary["supports_split_frame"] is False


def test_active_speaker_tracking_does_not_split_multiple_idle_faces() -> None:
    summary = summarize_face_samples(
        [
            [{"center_x_ratio": 0.25}, {"center_x_ratio": 0.75}],
            [{"center_x_ratio": 0.25}, {"center_x_ratio": 0.75}],
        ]
    )
    projected = apply_active_speaker_tracking(
        summary,
        [
            {
                "anchor_ratio": 0.75,
                "active_subject_anchor_ratios": [0.75],
                "active_subject_bounds_ratios": [{"left": 0.68, "right": 0.82}],
            },
            {
                "anchor_ratio": 0.75,
                "active_subject_anchor_ratios": [0.75],
                "active_subject_bounds_ratios": [{"left": 0.68, "right": 0.82}],
            },
        ],
    )

    assert projected["max_face_count"] == 2
    assert projected["max_active_speaker_count"] == 1
    assert projected["supports_split_frame"] is False
    assert projected["adaptive_panel_count"] == 1
    assert projected["split_decision_reason"] == "single_active_speaker"


def test_active_speaker_tracking_splits_only_stable_simultaneous_speakers() -> None:
    summary = summarize_face_samples([[], [], []])
    active_sample = {
        "anchor_ratio": 0.24,
        "voice_overlap_count": 2,
        "active_subject_anchor_ratios": [0.24, 0.76],
        "active_subject_bounds_ratios": [
            {"left": 0.17, "right": 0.31},
            {"left": 0.69, "right": 0.83},
        ],
    }
    projected = apply_active_speaker_tracking(summary, [active_sample, active_sample, active_sample])

    assert projected["max_active_speaker_count"] == 2
    assert projected["supports_split_frame"] is True
    assert projected["adaptive_panel_count"] == 2
    assert all(
        sample["active_speaker_count"] == 2
        for sample in projected["sample_anchor_pairs"]
    )


def test_active_speaker_tracking_rejects_multiple_moving_faces_without_voice_overlap() -> None:
    summary = summarize_face_samples([[], [], []])
    moving_faces = {
        "anchor_ratio": 0.24,
        "voice_overlap_count": 0,
        "active_subject_anchor_ratios": [0.24, 0.76],
        "active_subject_bounds_ratios": [
            {"left": 0.17, "right": 0.31},
            {"left": 0.69, "right": 0.83},
        ],
    }

    projected = apply_active_speaker_tracking(summary, [moving_faces, moving_faces, moving_faces])

    assert projected["max_active_speaker_count"] == 1
    assert projected["supports_split_frame"] is False
    assert projected["split_evidence_source"] == "transcript_vad_face_association"


def test_fast_confirmed_speaker_change_enables_two_person_layout_temporarily() -> None:
    samples = [
        {
            "offset_seconds": 0.0,
            "anchor_ratio": 0.25,
            "selection_source": "initial_face",
            "visible_subject_anchor_ratios": [0.25, 0.75],
            "visible_subject_bounds_ratios": [
                {"left": 0.18, "right": 0.32},
                {"left": 0.68, "right": 0.82},
            ],
            "visible_subject_motion_scores": [3.0, 0.2],
        },
        {
            "offset_seconds": 1.0,
            "anchor_ratio": 0.75,
            "selection_source": "confirmed_mouth_motion",
            "visible_subject_anchor_ratios": [0.25, 0.75],
            "visible_subject_bounds_ratios": [
                {"left": 0.18, "right": 0.32},
                {"left": 0.68, "right": 0.82},
            ],
            "visible_subject_motion_scores": [0.2, 3.0],
        },
        {
            "offset_seconds": 2.0,
            "anchor_ratio": 0.75,
            "selection_source": "same_active_face",
            "visible_subject_anchor_ratios": [0.25, 0.75],
            "visible_subject_bounds_ratios": [
                {"left": 0.18, "right": 0.32},
                {"left": 0.68, "right": 0.82},
            ],
            "visible_subject_motion_scores": [0.1, 2.5],
        },
    ]

    annotated = _annotate_conversation_layout_samples(samples, conversation_windows=[])
    projected = apply_active_speaker_tracking(summarize_face_samples([[], [], []]), annotated)

    assert projected["supports_split_frame"] is True
    assert projected["adaptive_panel_count"] == 2
    assert annotated[1]["conversation_layout"] is True
    assert annotated[1]["active_subject_anchor_ratios"] == [0.25, 0.75]


def test_strong_reaction_layout_is_capped_at_twelve_hundred_milliseconds() -> None:
    samples = [
        {
            "offset_seconds": offset,
            "anchor_ratio": 0.25,
            "selection_source": "same_active_face",
            "visible_subject_anchor_ratios": [0.25, 0.75],
            "visible_subject_bounds_ratios": [],
            "visible_subject_motion_scores": [2.0, 4.5 if offset == 1.0 else 0.1],
        }
        for offset in (1.0, 1.5, 2.0, 2.5)
    ]

    annotated = _annotate_conversation_layout_samples(samples, conversation_windows=[])

    assert annotated[0]["reaction_layout"] is True
    assert annotated[2]["reaction_layout"] is True
    assert annotated[3].get("reaction_layout") is not True
