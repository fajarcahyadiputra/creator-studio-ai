from app.domain.contracts import (
    AudioExtractionPlan,
    AudioExtractionResult,
    ClipOutputResult,
    ClipRenderContext,
    MediaAssetValidationContext,
    MediaAssetValidationResult,
    TranscriptionPersistenceRequest,
    TranscriptionPlan,
    TranscriptionResult,
)


def test_clip_render_context_accepts_internal_payload() -> None:
    context = ClipRenderContext.model_validate(
        {
            "clip_output_id": "output-1",
            "job_id": "job-1",
            "candidate_id": "candidate-row-1",
            "version": 1,
            "quality_status": "PENDING",
            "render_settings": {"visual": {"aspect_ratio": "9:16"}},
            "candidate": {
                "candidate_id": "candidate-01",
                "title": "Candidate title",
                "summary": "Candidate summary",
                "hook_text": "Hook text",
                "start_ms": "12000",
                "end_ms": "30000",
                "duration_ms": "18000",
            },
            "source_media": {
                "media_asset_id": "asset-1",
                "object_key": "users/u/uploads/source.mp4",
                "download_url": "http://minio:9000/signed-read-url",
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
                        "end_seconds": 15.0,
                        "text": "Halo semuanya",
                        "speaker_label": None,
                        "confidence": 0.92,
                        "words": [
                            {
                                "start_seconds": 12.0,
                                "end_seconds": 12.4,
                                "text": "Halo",
                                "confidence": 0.98,
                            }
                        ],
                    }
                ],
            },
            "output_targets": {
                "preview_object_key": None,
                "final_object_key": None,
                "metadata_object_key": None,
                "thumbnail_object_key": None,
                "subtitle_object_key": None,
            },
            "artifact_uploads": [
                {
                    "artifact": "preview",
                    "object_key": "jobs/job-1/clip-outputs/output-1/preview.mp4",
                    "content_type": "video/mp4",
                    "upload_url": "http://minio:9000/upload/preview.mp4",
                }
            ],
        }
    )

    assert context.clip_output_id == "output-1"
    assert context.candidate.duration_ms == "18000"
    assert context.source_media.media_asset_id == "asset-1"
    assert context.transcript is not None


def test_clip_output_result_accepts_worker_result_payload() -> None:
    result = ClipOutputResult.model_validate(
        {
            "quality_status": "PASSED",
            "preview_object_key": "users/u/jobs/j/previews/c1.mp4",
            "subtitle_object_key": "users/u/jobs/j/subtitles/c1.srt",
            "subtitle_format": "srt",
            "subtitle_language": "id",
            "subtitle_burned_in": False,
            "quality_report": {"score": 9.1},
            "duration_ms": "18000",
            "width": 1080,
            "height": 1920,
        }
    )

    assert result.quality_status == "PASSED"
    assert result.duration_ms == "18000"
    assert result.subtitle_format == "srt"


def test_media_asset_validation_result_accepts_probe_metadata() -> None:
    result = MediaAssetValidationResult.model_validate(
        {
            "status": "READY",
            "duration_ms": "65432",
            "width": 1920,
            "height": 1080,
            "frame_rate": 29.97,
            "audio_sample_rate": 48000,
            "codec_name": "h264",
            "audio_codec_name": "aac",
            "rotation": 90,
            "metadata": {"source": "ffprobe"},
        }
    )

    assert result.status == "READY"
    assert result.duration_ms == "65432"
    assert result.codec_name == "h264"


def test_media_asset_validation_context_accepts_internal_payload() -> None:
    context = MediaAssetValidationContext.model_validate(
        {
            "media_asset_id": "asset-1",
            "user_id": "user-1",
            "project_id": "project-1",
            "type": "VIDEO",
            "status": "VALIDATING",
            "object_key": "users/user-1/uploads/u1/source/video.mp4",
            "display_name": "video.mp4",
            "original_file_name": "video.mp4",
            "mime_type": "video/mp4",
            "extension": "mp4",
            "size_bytes": "123456789",
            "checksum_sha256": "a" * 64,
            "download_url": "http://minio:9000/signed-read-url",
            "metadata": {"validation": {"status": "PENDING_WORKER"}},
        }
    )

    assert context.media_asset_id == "asset-1"
    assert context.size_bytes == "123456789"


def test_audio_extraction_plan_accepts_worker_payload() -> None:
    plan = AudioExtractionPlan.model_validate(
        {
            "media_asset_id": "asset-1",
            "user_id": "user-1",
            "object_key": "users/user-1/uploads/u1/source/video.mp4",
            "source_url": "http://minio:9000/signed-read-url",
            "working_directory": "/tmp/creator-studio/user-1/asset-1",
            "output_audio_path": "/tmp/creator-studio/user-1/asset-1/audio.wav",
            "sample_rate": 16000,
            "command": [
                "ffmpeg",
                "-hide_banner",
                "-nostdin",
                "-y",
                "-i",
                "http://minio:9000/signed-read-url",
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "pcm_s16le",
                "/tmp/creator-studio/user-1/asset-1/audio.wav",
            ],
        }
    )

    assert plan.media_asset_id == "asset-1"
    assert plan.command[0] == "ffmpeg"


def test_audio_extraction_result_accepts_worker_payload() -> None:
    result = AudioExtractionResult.model_validate(
        {
            "media_asset_id": "asset-1",
            "output_audio_path": "/tmp/creator-studio/user-1/asset-1/audio.wav",
            "sample_rate": 16000,
            "command": [
                "ffmpeg",
                "-hide_banner",
                "-nostdin",
                "-y",
                "-i",
                "http://minio:9000/signed-read-url",
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "pcm_s16le",
                "/tmp/creator-studio/user-1/asset-1/audio.wav",
            ],
        }
    )

    assert result.media_asset_id == "asset-1"
    assert result.output_audio_path.endswith("audio.wav")


def test_transcription_plan_accepts_worker_payload() -> None:
    plan = TranscriptionPlan.model_validate(
        {
            "media_asset_id": "asset-1",
            "job_id": "job-1",
            "user_id": "user-1",
            "audio_path": "/tmp/creator-studio/user-1/asset-1/audio.wav",
            "output_transcript_path": "/tmp/creator-studio/user-1/asset-1/transcript.json",
            "language_hint": "id",
            "custom_vocabulary": ["retention", "hook"],
        }
    )

    assert plan.media_asset_id == "asset-1"
    assert plan.job_id == "job-1"
    assert plan.output_transcript_path.endswith("transcript.json")


def test_transcription_result_accepts_worker_payload() -> None:
    result = TranscriptionResult.model_validate(
        {
            "media_asset_id": "asset-1",
            "job_id": "job-1",
            "output_transcript_path": "/tmp/creator-studio/user-1/asset-1/transcript.json",
            "transcript": {
                "language": "id",
                "duration_seconds": 18.0,
                "segments": [
                    {
                        "segment_id": "segment-0001",
                        "start_seconds": 0.0,
                        "end_seconds": 18.0,
                        "text": "Halo semuanya, kita bahas retention hari ini.",
                        "speaker_label": None,
                        "confidence": 0.91,
                        "words": [
                            {
                                "start_seconds": 0.0,
                                "end_seconds": 0.4,
                                "text": "Halo",
                                "confidence": 0.97,
                            }
                        ],
                    }
                ],
            },
        }
    )

    assert result.media_asset_id == "asset-1"
    assert result.job_id == "job-1"
    assert result.transcript.language == "id"


def test_transcription_persistence_request_accepts_internal_payload() -> None:
    payload = TranscriptionPersistenceRequest.model_validate(
        {
            "media_asset_id": "asset-1",
            "job_id": "job-1",
            "output_transcript_path": "/tmp/creator-studio/user-1/asset-1/transcript.json",
            "model_identifier": "faster-whisper:small",
            "word_timestamps": True,
            "transcript": {
                "language": "id",
                "duration_seconds": 18.0,
                "segments": [
                    {
                        "segment_id": "segment-0001",
                        "start_seconds": 0.0,
                        "end_seconds": 18.0,
                        "text": "Halo semuanya, kita bahas retention hari ini.",
                        "speaker_label": None,
                        "confidence": 0.91,
                        "words": [],
                    }
                ],
            },
        }
    )

    assert payload.media_asset_id == "asset-1"
    assert payload.model_identifier == "faster-whisper:small"
