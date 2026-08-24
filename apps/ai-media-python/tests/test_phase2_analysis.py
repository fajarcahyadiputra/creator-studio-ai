import pytest

from app.activities.phase2_analysis import (
    MAX_TRANSCRIPT_SEGMENTS,
    enrich_analysis_inputs,
    prepare_analysis_inputs,
    prepare_analysis_inputs_from_transcript,
)


@pytest.mark.asyncio
async def test_prepare_analysis_inputs_accepts_snapshot_payload() -> None:
    result = await prepare_analysis_inputs(
        {
            "input_snapshot": {
                "analysis_inputs": {
                    "transcript": {
                        "language": "id",
                        "duration_seconds": 12.5,
                        "segments": [
                            {
                                "segment_id": "segment-0001",
                                "start_seconds": 0.0,
                                "end_seconds": 12.5,
                                "text": "Kita bahas hook yang bikin orang berhenti scroll.",
                                "speaker_label": None,
                                "confidence": 0.93,
                                "words": [],
                            }
                        ],
                    },
                    "scenes": [],
                    "silences": [],
                }
            }
        }
    )

    assert result["transcript"]["language"] == "id"
    assert len(result["transcript"]["segments"]) == 1


@pytest.mark.asyncio
async def test_prepare_analysis_inputs_from_transcript_creates_minimal_inputs() -> None:
    result = await prepare_analysis_inputs_from_transcript(
        {
            "media_asset_id": "asset-1",
            "output_transcript_path": "/tmp/creator-studio/user-1/asset-1/transcript.json",
            "transcript": {
                "language": "id",
                "duration_seconds": 18.0,
                "segments": [
                    {
                        "segment_id": "segment-0001",
                        "start_seconds": 0.0,
                        "end_seconds": 18.0,
                        "text": "Halo semuanya, hari ini kita bedah retention.",
                        "speaker_label": None,
                        "confidence": 0.91,
                        "words": [],
                    }
                ],
            },
        }
    )

    assert result["transcript"]["segments"][0]["segment_id"] == "segment-0001"
    assert result["scenes"] == []
    assert result["silences"] == []


@pytest.mark.asyncio
async def test_prepare_analysis_inputs_preserves_continuous_long_timeline() -> None:
    source_segments = [
        {
            "segment_id": f"source-{index:04d}",
            "start_seconds": float(index * 2),
            "end_seconds": float((index + 1) * 2),
            "text": (
                "Pembicara menjelaskan satu bagian penting dari topik tanpa tanda baca akhir "
                f"pada urutan {index}"
            ),
            "speaker_label": "SPEAKER_01",
            "confidence": 0.9,
            "words": [],
        }
        for index in range(500)
    ]

    result = await prepare_analysis_inputs_from_transcript(
        {
            "media_asset_id": "asset-long",
            "output_transcript_path": "/tmp/transcript-long.json",
            "transcript": {
                "language": "id",
                "duration_seconds": 1000.0,
                "segments": source_segments,
            },
        }
    )

    segments = result["transcript"]["segments"]
    assert len(segments) == MAX_TRANSCRIPT_SEGMENTS
    assert segments[0]["start_seconds"] == 0.0
    assert segments[-1]["end_seconds"] == 1000.0
    assert max(
        current["start_seconds"] - previous["end_seconds"]
        for previous, current in zip(segments, segments[1:])
    ) <= 0.01
    assert not segments[-1]["text"].endswith("...")


@pytest.mark.asyncio
async def test_enrich_analysis_inputs_generates_scene_and_silence_boundaries() -> None:
    result = await enrich_analysis_inputs(
        {
            "input_snapshot": {
                "strategy": {
                    "maximum_duration_seconds": 18,
                    "remove_long_silence": True,
                }
            },
            "analysis_inputs": {
                "transcript": {
                    "language": "id",
                    "duration_seconds": 18.0,
                    "segments": [
                        {
                            "segment_id": "segment-0001",
                            "start_seconds": 0.0,
                            "end_seconds": 5.0,
                            "text": "Halo semuanya, hari ini kita bedah retention.",
                            "speaker_label": "A",
                            "confidence": 0.91,
                            "words": [],
                        },
                        {
                            "segment_id": "segment-0002",
                            "start_seconds": 5.7,
                            "end_seconds": 12.0,
                            "text": "Kalau hook terlalu lambat, penonton langsung pergi.",
                            "speaker_label": "A",
                            "confidence": 0.9,
                            "words": [],
                        },
                        {
                            "segment_id": "segment-0003",
                            "start_seconds": 12.0,
                            "end_seconds": 18.0,
                            "text": "Makanya pembuka harus cepat dan jelas.",
                            "speaker_label": "B",
                            "confidence": 0.92,
                            "words": [],
                        },
                    ],
                },
                "scenes": [],
                "silences": [],
            },
        }
    )

    assert len(result["scenes"]) >= 1
    assert len(result["silences"]) == 1
    assert result["silences"][0]["start_seconds"] == 5.0
    assert result["silences"][0]["end_seconds"] == 5.7
