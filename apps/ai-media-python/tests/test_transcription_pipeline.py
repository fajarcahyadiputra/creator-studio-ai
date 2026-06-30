from types import SimpleNamespace

import pytest

from app.activities.transcription_pipeline import (
    build_transcript_document,
    prepare_transcription,
    submit_transcription_result,
)


@pytest.mark.asyncio
async def test_prepare_transcription_builds_stable_plan() -> None:
    result = await prepare_transcription(
        {
            "job_id": "job-1",
            "media_asset_id": "asset-1",
            "output_audio_path": "/tmp/creator-studio/user-1/asset-1/audio.wav",
            "sample_rate": 16000,
            "command": ["ffmpeg", "-i", "input.mp4", "audio.wav"],
            "input_snapshot": {
                "content": {
                    "source_language": "id",
                    "custom_vocabulary": ["retention", "hook", "  "],
                }
            },
        }
    )

    assert result["media_asset_id"] == "asset-1"
    assert result["job_id"] == "job-1"
    assert result["user_id"] == "user-1"
    assert result["language_hint"] == "id"
    assert result["output_transcript_path"].endswith("/tmp/creator-studio/user-1/asset-1/transcript.json")
    assert result["custom_vocabulary"] == ["retention", "hook"]


def test_build_transcript_document_maps_segments_and_words() -> None:
    segments = [
        SimpleNamespace(
            start=0.0,
            end=2.4,
            text=" Halo retention builders ",
            avg_logprob=0.91,
            words=[
                SimpleNamespace(start=0.0, end=0.4, word=" Halo ", probability=0.98),
                SimpleNamespace(start=0.4, end=1.0, word="retention", probability=0.96),
            ],
        )
    ]

    transcript = build_transcript_document("id", segments)

    assert transcript.language == "id"
    assert transcript.duration_seconds == 2.4
    assert transcript.segments[0].segment_id == "segment-0001"
    assert transcript.segments[0].text == "Halo retention builders"
    assert transcript.segments[0].words[0].text == "Halo"
    assert transcript.segments[0].words[1].confidence == 0.96


def test_build_transcript_document_rejects_empty_segments() -> None:
    with pytest.raises(ValueError, match="transcription produced no segments"):
        build_transcript_document("id", [])


@pytest.mark.asyncio
async def test_submit_transcription_result_sends_internal_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    class FakeMediaAssetClient:
        async def submit_transcription_result(self, media_asset_id: str, payload: object) -> None:
            captured["media_asset_id"] = media_asset_id
            captured["payload"] = payload

    monkeypatch.setattr(
        "app.activities.transcription_pipeline.MediaAssetClient",
        lambda: FakeMediaAssetClient(),
    )
    monkeypatch.setattr(
        "app.activities.transcription_pipeline.get_settings",
        lambda: SimpleNamespace(FASTER_WHISPER_MODEL_SIZE="small"),
    )

    await submit_transcription_result(
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
                        "words": [],
                    }
                ],
            },
        }
    )

    assert captured["media_asset_id"] == "asset-1"
    payload = captured["payload"]
    assert getattr(payload, "job_id") == "job-1"
    assert getattr(payload, "model_identifier") == "faster-whisper:small"
    assert getattr(payload, "word_timestamps") is True
