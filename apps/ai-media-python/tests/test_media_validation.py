from app.activities.media_validation import build_media_asset_validation_result
from app.media.ffmpeg import ProbeSummary


def test_media_validation_result_marks_ready_when_probe_has_duration_and_audio() -> None:
    result = build_media_asset_validation_result(
        ProbeSummary(
            duration_ms=65432,
            width=1920,
            height=1080,
            frame_rate=29.97,
            audio_sample_rate=48000,
            codec_name="h264",
            audio_codec_name="aac",
            rotation=90,
            has_audio=True,
        ),
        mime_type="video/mp4",
        metadata={"validation": {"status": "PENDING_WORKER"}},
    )

    assert result.status == "READY"
    assert result.duration_ms == "65432"
    assert result.failure_reason is None
    assert result.metadata["validation"]["source"] == "ffprobe"
    assert result.metadata["validation"]["has_audio"] is True


def test_media_validation_result_marks_failed_when_video_has_no_audio() -> None:
    result = build_media_asset_validation_result(
        ProbeSummary(
            duration_ms=65432,
            width=1920,
            height=1080,
            frame_rate=29.97,
            audio_sample_rate=None,
            codec_name="h264",
            audio_codec_name=None,
            rotation=None,
            has_audio=False,
        ),
        mime_type="video/mp4",
        metadata={},
    )

    assert result.status == "FAILED"
    assert result.failure_reason == "No audio stream was detected for the uploaded video."


def test_media_validation_result_marks_failed_when_duration_is_missing() -> None:
    result = build_media_asset_validation_result(
        ProbeSummary(
            duration_ms=None,
            width=None,
            height=None,
            frame_rate=None,
            audio_sample_rate=48000,
            codec_name=None,
            audio_codec_name="aac",
            rotation=None,
            has_audio=True,
        ),
        mime_type="audio/mp4",
        metadata={},
    )

    assert result.status == "FAILED"
    assert result.failure_reason == "Media duration could not be determined."
