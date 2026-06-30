import pytest
from temporalio.exceptions import ApplicationError

from pathlib import Path

from app.activities.audio_pipeline import execute_audio_extraction, prepare_audio_extraction


@pytest.mark.asyncio
async def test_prepare_audio_extraction_builds_stable_plan() -> None:
    result = await prepare_audio_extraction(
        {
            "media_asset_id": "asset-1",
            "user_id": "user-1",
            "project_id": "project-1",
            "type": "VIDEO",
            "status": "READY",
            "object_key": "users/user-1/uploads/u1/source/video.mp4",
            "display_name": "video.mp4",
            "original_file_name": "video.mp4",
            "mime_type": "video/mp4",
            "extension": "mp4",
            "size_bytes": "123456789",
            "checksum_sha256": "a" * 64,
            "download_url": "http://minio:9000/signed-read-url",
            "metadata": {"validation": {"status": "READY"}},
        }
    )

    assert result["media_asset_id"] == "asset-1"
    assert result["sample_rate"] == 16000
    assert result["output_audio_path"].endswith("/user-1/asset-1/audio.wav")
    assert result["command"][0] == "ffmpeg"
    assert result["command"][-1].endswith("/user-1/asset-1/audio.wav")


@pytest.mark.asyncio
async def test_prepare_audio_extraction_rejects_non_ready_media_assets() -> None:
    with pytest.raises(ApplicationError):
        await prepare_audio_extraction(
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
                "metadata": {"validation": {"status": "QUEUED"}},
            }
        )


@pytest.mark.asyncio
async def test_execute_audio_extraction_rejects_missing_output_file() -> None:
    missing_output = Path("C:/tmp/creator-studio-tests/audio-missing.wav")
    if missing_output.exists():
        missing_output.unlink()

    with pytest.raises(RuntimeError, match="without creating the extracted audio file"):
        await execute_audio_extraction(
            {
                "media_asset_id": "asset-1",
                "user_id": "user-1",
                "object_key": "users/user-1/uploads/u1/source/video.mp4",
                "source_url": "http://minio:9000/signed-read-url",
                "working_directory": "C:/tmp/creator-studio-tests",
                "output_audio_path": str(missing_output),
                "sample_rate": 16000,
                "command": ["cmd", "/c", "exit", "0"],
            }
        )
