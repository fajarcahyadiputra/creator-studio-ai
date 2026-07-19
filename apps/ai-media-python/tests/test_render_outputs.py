import asyncio
import sys

import pytest

from app.activities.render_outputs import (
    SubtitleCue,
    SubtitleCueWord,
    _attach_speaker_anchor_map,
    _apply_subtitle_text_case,
    _build_active_speaker_strategy,
    _build_subtitle_cues,
    _detect_face_layout_summary,
    _estimate_ass_word_width,
    _render_ass,
    _resolve_ass_word_spacing,
    _run_command_with_heartbeat,
    execute_clip_output_render,
)
from app.domain.contracts import TranscriptSegment, TranscriptWord


@pytest.mark.asyncio
async def test_face_layout_processes_only_frames_ffmpeg_actually_emits(tmp_path, monkeypatch) -> None:
    async def fake_run_command(*_args, **_kwargs) -> None:
        (tmp_path / "face-sample-001.jpg").write_bytes(b"frame-1")
        (tmp_path / "face-sample-002.jpg").write_bytes(b"frame-2")

    detected_paths: list[str] = []

    def fake_detect(path, **_kwargs):
        detected_paths.append(str(path))
        return [
            {
                "x": 300,
                "y": 80,
                "width": 120,
                "height": 140,
                "center_x": 360.0,
                "center_x_ratio": 0.5625,
                "area": 16800,
                "image_width": 640,
                "image_height": 360,
                "detector": "yunet",
            }
        ]

    monkeypatch.setattr("app.activities.render_outputs._run_command_with_heartbeat", fake_run_command)
    monkeypatch.setattr("app.activities.render_outputs.detect_faces_in_image", fake_detect)
    monkeypatch.setattr(
        "app.activities.render_outputs.get_settings",
        lambda: type(
            "Settings",
            (),
            {
                "FACE_DETECTION_YUNET_MODEL_PATH": None,
                "FACE_DETECTION_YUNET_SCORE_THRESHOLD": 0.72,
            },
        )(),
    )

    summary = await _detect_face_layout_summary(
        source="source.mp4",
        clip_start_seconds=0.0,
        clip_duration_seconds=2.0,
        working_directory=tmp_path,
        timeout_seconds=30.0,
    )

    assert len(detected_paths) == 2
    assert summary["sample_count"] == 2
    assert summary["valid_face_sample_count"] == 2
    assert summary["detection_backend"] == "opencv_yunet"
    assert summary["detection_sources"] == ["yunet"]


def test_active_speaker_strategy_uses_clip_relative_timing_and_fast_switch_lead() -> None:
    strategy = _build_active_speaker_strategy(
        [
            TranscriptSegment(
                segment_id="segment-a",
                start_seconds=100.0,
                end_seconds=102.0,
                text="Pembicara pertama",
                speaker_label="A",
            ),
            TranscriptSegment(
                segment_id="segment-b",
                start_seconds=102.0,
                end_seconds=105.0,
                text="Pembicara kedua",
                speaker_label="B",
            ),
        ],
        clip_start_seconds=100.0,
        clip_duration_seconds=5.0,
    )

    assert strategy["available"] is True
    assert strategy["source"] == "transcript_diarization"
    assert strategy["windows"][0]["start_seconds"] == pytest.approx(0.0)
    assert strategy["windows"][0]["end_seconds"] == pytest.approx(1.8)
    assert strategy["windows"][1]["start_seconds"] == pytest.approx(1.8)
    assert strategy["windows"][1]["end_seconds"] == pytest.approx(5.0)
    assert strategy["transition_seconds"] == pytest.approx(0.16)


def test_active_speaker_strategy_prefers_word_timing_and_collapses_micro_turns() -> None:
    strategy = _build_active_speaker_strategy(
        [
            TranscriptSegment(
                segment_id="segment-a1",
                start_seconds=10.0,
                end_seconds=11.0,
                text="Pembicara pertama",
                speaker_label="A",
                words=[TranscriptWord(start_seconds=10.1, end_seconds=10.9, text="pertama")],
            ),
            TranscriptSegment(
                segment_id="segment-b-short",
                start_seconds=11.0,
                end_seconds=11.15,
                text="ya",
                speaker_label="B",
            ),
            TranscriptSegment(
                segment_id="segment-a2",
                start_seconds=11.15,
                end_seconds=12.0,
                text="Pembicara pertama lanjut",
                speaker_label="A",
            ),
            TranscriptSegment(
                segment_id="segment-b",
                start_seconds=12.0,
                end_seconds=14.0,
                text="Pembicara kedua",
                speaker_label="B",
            ),
        ],
        clip_start_seconds=10.0,
        clip_duration_seconds=4.0,
    )

    assert [window["speaker_label"] for window in strategy["windows"]] == ["A", "B"]
    assert strategy["windows"][0]["end_seconds"] == pytest.approx(1.8)
    assert strategy["windows"][1]["speech_start_seconds"] == pytest.approx(2.0)


def test_speaker_anchor_map_uses_single_face_visual_evidence() -> None:
    strategy = {
        "speaker_order": ["A", "B"],
        "windows": [
            {"speaker_label": "A", "start_seconds": 0.0, "end_seconds": 2.0},
            {"speaker_label": "B", "start_seconds": 2.0, "end_seconds": 4.0},
        ],
    }
    _attach_speaker_anchor_map(
        strategy,
        {
            "sample_offsets_seconds": [1.0, 3.0],
            "sample_anchor_pairs": [
                {"face_count": 1, "primary_anchor_ratio": 0.76},
                {"face_count": 1, "primary_anchor_ratio": 0.24},
            ],
            "left_anchor_ratio": 0.24,
            "right_anchor_ratio": 0.76,
        },
    )

    assert strategy["speaker_anchor_ratios"] == {"A": 0.76, "B": 0.24}
    assert strategy["speaker_anchor_source"] == "single_face_visual_evidence"


def test_active_speaker_strategy_declares_face_tracking_fallback_without_diarization() -> None:
    strategy = _build_active_speaker_strategy(
        [
            TranscriptSegment(
                segment_id="segment-1",
                start_seconds=20.0,
                end_seconds=24.0,
                text="Tidak ada label pembicara",
                speaker_label=None,
            )
        ],
        clip_start_seconds=20.0,
        clip_duration_seconds=4.0,
    )

    assert strategy["available"] is False
    assert strategy["source"] == "face_tracking_fallback"
    assert strategy["windows"] == []


@pytest.mark.asyncio
async def test_render_subprocess_keeps_one_communicate_task_across_heartbeats(monkeypatch) -> None:
    heartbeats: list[dict[str, object]] = []
    monkeypatch.setattr("app.activities.render_outputs.activity.heartbeat", heartbeats.append)

    await _run_command_with_heartbeat(
        [sys.executable, "-c", "import time; time.sleep(0.08)"],
        timeout_seconds=1,
        heartbeat_interval_seconds=0.01,
        heartbeat_details={"stage": "RENDERING_FINAL_CLIPS"},
    )

    assert heartbeats


@pytest.mark.asyncio
async def test_render_subprocess_is_cleaned_up_when_activity_is_cancelled(monkeypatch) -> None:
    monkeypatch.setattr("app.activities.render_outputs.activity.heartbeat", lambda _details: None)
    render_task = asyncio.create_task(
        _run_command_with_heartbeat(
            [sys.executable, "-c", "import time; time.sleep(10)"],
            timeout_seconds=20,
            heartbeat_interval_seconds=0.01,
            heartbeat_details={"stage": "RENDERING_FINAL_CLIPS"},
        )
    )
    await asyncio.sleep(0.04)
    render_task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await render_task


@pytest.mark.asyncio
async def test_execute_clip_output_render_executes_render_pipeline(tmp_path, monkeypatch) -> None:
    uploads: list[tuple[str, str, bytes]] = []
    commands: list[list[str]] = []

    async def fake_run_command(command: list[str], *, timeout_seconds: float) -> None:
        commands.append(command)
        destination = command[-1]
        if destination.endswith(".mp4"):
            tmp_path.joinpath(destination).write_bytes(b"fake-mp4")
        elif destination.endswith(".jpg"):
            tmp_path.joinpath(destination).write_bytes(b"fake-jpg")

    async def fake_ffprobe(source: str, *, timeout_seconds: float) -> dict[str, object]:
        is_preview = source.endswith("preview.mp4")
        return {
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "h264",
                    "width": 540 if is_preview else 1080,
                    "height": 960 if is_preview else 1920,
                    "avg_frame_rate": "24/1" if is_preview else "30/1",
                },
                {
                    "codec_type": "audio",
                    "codec_name": "aac",
                    "sample_rate": "48000",
                },
            ],
            "format": {
                "duration": "18.000",
            },
        }

    async def fake_upload_file(upload_url: str, path, *, content_type: str) -> None:
        uploads.append((upload_url, content_type, path.read_bytes()))

    monkeypatch.setattr("app.activities.render_outputs.get_settings", lambda: type("S", (), {
        "TEMP_WORKDIR": str(tmp_path),
        "TRANSCRIPTION_TIMEOUT_SECONDS": 30.0,
        "AUDIO_EXTRACTION_TIMEOUT_SECONDS": 30.0,
        "MEDIA_PROBE_TIMEOUT_SECONDS": 30.0,
    })())
    monkeypatch.setattr("app.activities.render_outputs._run_command", fake_run_command)
    monkeypatch.setattr("app.activities.render_outputs.run_ffprobe_json", fake_ffprobe)
    monkeypatch.setattr("app.activities.render_outputs._upload_file", fake_upload_file)

    result = await execute_clip_output_render(
        {
            "clip_output_id": "output-1",
            "job_id": "job-1",
            "candidate_id": "candidate-row-1",
            "render_settings": {
                "visual": {"aspect_ratio": "9:16"},
                "subtitle": {"format": "srt", "language": "id"},
                "metadata": {
                    "suggested_caption": "Caption singkat",
                    "suggested_cta": "Follow untuk part berikutnya",
                    "suggested_hashtags": ["#retention", "#content"],
                    "thumbnail_text": "STOP SCROLL",
                    "hook_second": 0,
                    "main_point_second": 6.2,
                    "punchline_second": 17.5,
                    "retention_level": "very_high",
                    "requires_context": False,
                    "can_standalone": True,
                },
                "strategy": {"target_platform": "TIKTOK"},
            },
            "candidate": {
                "candidate_id": "candidate-01",
                "title": "Judul clip",
                "summary": "Ringkasan clip",
                "hook_text": "Kalimat hook",
                "start_ms": "12000",
                "end_ms": "30000",
                "duration_ms": "18000",
            },
            "source_media": {
                "media_asset_id": "asset-1",
                "object_key": "users/u/uploads/source.mp4",
                "download_url": "http://minio:9000/source.mp4",
                "mime_type": "video/mp4",
                "duration_ms": "65000",
                "width": 1920,
                "height": 1080,
            },
            "transcript": {
                "language": "id",
                "segments": [
                    {
                        "segment_id": "segment-1",
                        "start_seconds": 12.0,
                        "end_seconds": 13.2,
                        "text": "Halo semuanya retention itu penting",
                        "speaker_label": None,
                        "confidence": 0.95,
                        "words": [
                            {"start_seconds": 12.0, "end_seconds": 12.2, "text": "Halo", "confidence": 0.99},
                            {"start_seconds": 12.2, "end_seconds": 12.5, "text": "semuanya", "confidence": 0.99},
                            {"start_seconds": 12.5, "end_seconds": 12.8, "text": "retention", "confidence": 0.99},
                            {"start_seconds": 12.8, "end_seconds": 13.0, "text": "itu", "confidence": 0.99},
                            {"start_seconds": 13.0, "end_seconds": 13.2, "text": "penting", "confidence": 0.99},
                        ],
                    }
                ],
            },
            "output_targets": {
                "preview_object_key": "users/user-1/jobs/job-1/clip-outputs/output-1/preview.mp4",
                "final_object_key": "users/user-1/jobs/job-1/clip-outputs/output-1/final.mp4",
                "metadata_object_key": "users/user-1/jobs/job-1/clip-outputs/output-1/metadata.json",
                "thumbnail_object_key": "users/user-1/jobs/job-1/clip-outputs/output-1/thumbnail.jpg",
                "subtitle_object_key": "users/user-1/jobs/job-1/clip-outputs/output-1/subtitle.srt",
            },
            "artifact_uploads": [
                {
                    "artifact": "preview",
                    "object_key": "users/user-1/jobs/job-1/clip-outputs/output-1/preview.mp4",
                    "content_type": "video/mp4",
                    "upload_url": "http://minio:9000/upload/preview.mp4",
                },
                {
                    "artifact": "final",
                    "object_key": "users/user-1/jobs/job-1/clip-outputs/output-1/final.mp4",
                    "content_type": "video/mp4",
                    "upload_url": "http://minio:9000/upload/final.mp4",
                },
                {
                    "artifact": "metadata",
                    "object_key": "users/user-1/jobs/job-1/clip-outputs/output-1/metadata.json",
                    "content_type": "application/json",
                    "upload_url": "http://minio:9000/upload/metadata.json",
                },
                {
                    "artifact": "thumbnail",
                    "object_key": "users/user-1/jobs/job-1/clip-outputs/output-1/thumbnail.jpg",
                    "content_type": "image/jpeg",
                    "upload_url": "http://minio:9000/upload/thumbnail.jpg",
                },
                {
                    "artifact": "subtitle",
                    "object_key": "users/user-1/jobs/job-1/clip-outputs/output-1/subtitle.srt",
                    "content_type": "application/x-subrip",
                    "upload_url": "http://minio:9000/upload/subtitle.srt",
                },
                {
                    "artifact": "subtitle_vtt",
                    "object_key": "users/user-1/jobs/job-1/clip-outputs/output-1/subtitle.vtt",
                    "content_type": "text/vtt",
                    "upload_url": "http://minio:9000/upload/subtitle.vtt",
                },
                {
                    "artifact": "subtitle_json",
                    "object_key": "users/user-1/jobs/job-1/clip-outputs/output-1/subtitle.json",
                    "content_type": "application/json",
                    "upload_url": "http://minio:9000/upload/subtitle.json",
                },
            ],
        }
    )

    assert result["quality_status"] == "PASSED"
    assert result["preview_object_key"] == "users/user-1/jobs/job-1/clip-outputs/output-1/preview.mp4"
    assert result["final_object_key"] == "users/user-1/jobs/job-1/clip-outputs/output-1/final.mp4"
    assert result["subtitle_object_key"] == "users/user-1/jobs/job-1/clip-outputs/output-1/subtitle.srt"
    assert result["subtitle_format"] == "srt"
    assert result["subtitle_language"] == "id"
    assert result["quality_report"]["manifest_version"] == "phase2-render-manifest-v2"
    assert len(result["quality_report"]["artifacts"]) == 7
    assert result["quality_report"]["render_plan"]["command"][0] == "ffmpeg"
    assert result["quality_report"]["render_plan"]["crop_mode"] == "center_crop"
    assert result["quality_report"]["preview_plan"]["command"][0] == "ffmpeg"
    assert result["quality_report"]["candidate"]["title"] == "Judul clip"
    assert result["quality_report"]["metadata"]["retention_level"] == "very_high"
    assert result["quality_report"]["metadata"]["suggested_hashtags"] == ["#retention", "#content"]
    assert result["quality_report"]["validation"]["status"] == "passed"
    assert result["quality_report"]["validation"]["checks"]["playable"] is True
    assert result["quality_report"]["validation"]["checks"]["preview_playable"] is True
    assert result["quality_report"]["validation"]["checks"]["thumbnail_generated"] is True
    assert result["quality_report"]["validation"]["checks"]["subtitle_sidecar_generated"] is True
    assert result["quality_report"]["validation"]["expected"]["video_codec"] == "h264"
    assert result["quality_report"]["validation"]["observed"]["final"]["subtitle_format"] == "srt"
    assert result["quality_report"]["validation"]["observed"]["preview"]["width"] == 540
    assert result["quality_report"]["subtitle"]["sidecars"]["vtt"] == "subtitle.vtt"
    assert result["quality_report"]["subtitle"]["sidecars"]["json"] == "subtitle.json"
    assert result["duration_ms"] == "18000"
    assert result["width"] == 1080
    assert result["height"] == 1920
    assert len(commands) == 3
    assert any("crop=608:1080:656:0,scale=1080:1920,fps=30" in argument for argument in commands[0])
    assert any("scale=540:960,fps=24" in argument for argument in commands[1])
    assert uploads[0][0] == "http://minio:9000/upload/preview.mp4"
    assert any(b"Halo semuanya retention" in payload for _, _, payload in uploads)
    assert (tmp_path / "clip-output-renders" / "output-1" / "subtitle.vtt").exists()
    assert (tmp_path / "clip-output-renders" / "output-1" / "subtitle.json").exists()


def test_build_subtitle_cues_normalizes_literal_backslash_n_text() -> None:
    cues = _build_subtitle_cues(
        transcript_segments=[
            TranscriptSegment(
                segment_id="segment-1",
                start_seconds=0.0,
                end_seconds=3.0,
                text="Oh wow baru ngerti gue.\\nMasa kok ini apa sih?",
                speaker_label=None,
                confidence=0.91,
                words=[],
            )
        ],
        clip_start_seconds=0.0,
        clip_duration_seconds=3.0,
    )

    assert cues
    assert any("Masa kok ini apa sih?" in cue.text for cue in cues)
    assert all("\\n" not in cue.text for cue in cues)


def test_build_subtitle_cues_respects_max_lines_setting() -> None:
    cues = _build_subtitle_cues(
        transcript_segments=[
            TranscriptSegment(
                segment_id="segment-1",
                start_seconds=0.0,
                end_seconds=5.0,
                text="satu dua tiga empat lima enam tujuh delapan sembilan sepuluh sebelas dua belas",
                speaker_label=None,
                confidence=0.91,
                words=[],
            )
        ],
        clip_start_seconds=0.0,
        clip_duration_seconds=5.0,
        max_lines=3,
    )

    assert cues
    assert cues[0].text.count("\n") <= 2
    reconstructed = " ".join(cue.text.replace("\n", " ") for cue in cues)
    assert "satu dua tiga empat lima enam tujuh delapan sembilan sepuluh sebelas dua belas" in reconstructed


def test_build_subtitle_cues_splits_to_new_cue_before_layout_overflow() -> None:
    cues = _build_subtitle_cues(
        transcript_segments=[
            TranscriptSegment(
                segment_id="segment-1",
                start_seconds=0.0,
                end_seconds=6.0,
                text="kamu sedang bersama siapa dan dimana sekarang lalu kenapa belum pulang juga malam ini",
                speaker_label=None,
                confidence=0.91,
                words=[],
            )
        ],
        clip_start_seconds=0.0,
        clip_duration_seconds=6.0,
        max_lines=1,
    )

    assert len(cues) >= 2
    reconstructed = " ".join(cue.text.replace("\n", " ") for cue in cues)
    assert "kamu sedang bersama siapa dan dimana sekarang lalu kenapa belum pulang juga malam ini" in reconstructed
    assert not cues[0].text.strip().lower().endswith("dan")
    assert not cues[1].text.strip().lower().startswith("lalu")


def test_render_ass_uses_ass_line_break_escape_for_multiline_cues() -> None:
    rendered = _render_ass(
        [
            SubtitleCue(
                start_seconds=0.0,
                end_seconds=2.0,
                text="Oh wow baru ngerti gue.\nMasa kok ini apa sih?",
            )
        ],
        layout_template="PODCAST_SPOTLIGHT_9X16",
    )

    assert r"Oh wow baru ngerti gue.\NMasa kok ini apa sih?" in rendered


def test_render_ass_outputs_timed_blue_mint_word_highlight_events() -> None:
    rendered = _render_ass(
        [
            SubtitleCue(
                start_seconds=0.0,
                end_seconds=1.6,
                text="PERBATASAN JAWA",
                words=(
                    SubtitleCueWord(text="PERBATASAN", duration_centiseconds=80),
                    SubtitleCueWord(text="JAWA", duration_centiseconds=80),
                ),
            )
        ],
        layout_template="PODCAST_SPOTLIGHT_9X16",
        word_highlight=True,
    )

    assert "Style: Highlight,Arial,48" in rendered
    assert "&H00F78F4B&" in rendered
    assert "&H00C4E77D&" in rendered
    assert "Dialogue: 2,0:00:00.00,0:00:00.80,Highlight" in rendered
    assert "Dialogue: 2,0:00:00.80,0:00:01.60,Highlight" in rendered
    assert "PERBATASAN" in rendered
    assert "JAWA" in rendered


def test_uppercase_highlight_layout_keeps_bold_words_visibly_separated() -> None:
    uppercase_words = [
        SubtitleCueWord(text="KONSTIKS", duration_centiseconds=80),
        SubtitleCueWord(text="PEMBURU", duration_centiseconds=80),
    ]
    lowercase_words = [
        SubtitleCueWord(text="konstiks", duration_centiseconds=80),
        SubtitleCueWord(text="pemburu", duration_centiseconds=80),
    ]

    assert _estimate_ass_word_width("KONSTIKS", 62) > _estimate_ass_word_width("konstiks", 62)
    assert _resolve_ass_word_spacing(uppercase_words, 62) == pytest.approx(28.52)
    assert _resolve_ass_word_spacing(lowercase_words, 62) == pytest.approx(19.84)


def test_apply_subtitle_text_case_preserves_word_timing_and_line_breaks() -> None:
    source = [
        SubtitleCue(
            start_seconds=1.0,
            end_seconds=2.0,
            text="Perbatasan Jawa",
            words=(
                SubtitleCueWord(text="Perbatasan", duration_centiseconds=60),
                SubtitleCueWord(text="Jawa", duration_centiseconds=40, line_break_before=True),
            ),
        )
    ]

    uppercase = _apply_subtitle_text_case(source, "UPPERCASE")
    lowercase = _apply_subtitle_text_case(source, "LOWERCASE")

    assert uppercase[0].text == "PERBATASAN JAWA"
    assert [word.text for word in uppercase[0].words] == ["PERBATASAN", "JAWA"]
    assert uppercase[0].words[1].line_break_before is True
    assert uppercase[0].words[1].duration_centiseconds == 40
    assert lowercase[0].text == "perbatasan jawa"


def test_render_ass_honors_top_and_safe_bottom_positions() -> None:
    cue = SubtitleCue(start_seconds=0.0, end_seconds=2.0, text="Posisi subtitle aman")

    top = _render_ass([cue], position="TOP", safe_margin_percent=12)
    bottom = _render_ass([cue], position="BOTTOM", safe_margin_percent=12)

    assert ",8,64,64,230,1" in top
    assert ",2,64,64,230,1" in bottom
