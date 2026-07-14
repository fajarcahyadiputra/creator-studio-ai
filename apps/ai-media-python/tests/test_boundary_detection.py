from app.domain.boundary_detection import (
    build_scene_boundaries,
    build_silence_boundaries,
    enrich_analysis_inputs,
)
from app.domain.contracts import AnalysisInputs


def test_build_scene_boundaries_splits_on_speaker_change_and_duration() -> None:
    analysis_inputs = AnalysisInputs.model_validate(
        {
            "transcript": {
                "language": "id",
                "duration_seconds": 30,
                "segments": [
                    {
                        "segment_id": "s1",
                        "start_seconds": 0,
                        "end_seconds": 4,
                        "text": "Kita mulai dari hook yang kuat.",
                        "speaker_label": "A",
                        "words": [],
                    },
                    {
                        "segment_id": "s2",
                        "start_seconds": 4,
                        "end_seconds": 10,
                        "text": "Lalu retention biasanya naik kalau payoff cepat.",
                        "speaker_label": "A",
                        "words": [],
                    },
                    {
                        "segment_id": "s3",
                        "start_seconds": 10.8,
                        "end_seconds": 18,
                        "text": "Tapi banyak creator masih terlalu lambat di pembuka.",
                        "speaker_label": "B",
                        "words": [],
                    },
                ],
            },
            "scenes": [],
            "silences": [],
        }
    )

    scenes = build_scene_boundaries(analysis_inputs.transcript, max_scene_duration_seconds=8)

    assert len(scenes) >= 2
    assert scenes[0].start_seconds == 0
    assert scenes[-1].end_seconds == 18


def test_build_silence_boundaries_detects_gaps_between_segments() -> None:
    analysis_inputs = AnalysisInputs.model_validate(
        {
            "transcript": {
                "language": "id",
                "duration_seconds": 20,
                "segments": [
                    {
                        "segment_id": "s1",
                        "start_seconds": 0,
                        "end_seconds": 5,
                        "text": "Bagian ini menjelaskan masalah utama",
                        "speaker_label": None,
                        "words": [],
                    },
                    {
                        "segment_id": "s2",
                        "start_seconds": 5.8,
                        "end_seconds": 12,
                        "text": "Lalu ada jeda sebelum insight berikutnya",
                        "speaker_label": None,
                        "words": [],
                    },
                ],
            },
            "scenes": [],
            "silences": [],
        }
    )

    silences = build_silence_boundaries(analysis_inputs.transcript, min_gap_seconds=0.45)

    assert len(silences) == 1
    assert silences[0].start_seconds == 5
    assert silences[0].end_seconds == 5.8


def test_enrich_analysis_inputs_preserves_existing_boundaries() -> None:
    analysis_inputs = AnalysisInputs.model_validate(
        {
            "transcript": {
                "language": "id",
                "duration_seconds": 12,
                "segments": [
                    {
                        "segment_id": "s1",
                        "start_seconds": 0,
                        "end_seconds": 12,
                        "text": "Semua transcript masuk ke satu segment dulu.",
                        "speaker_label": None,
                        "words": [],
                    }
                ],
            },
            "scenes": [{"scene_id": "scene-1", "start_seconds": 0, "end_seconds": 12}],
            "silences": [{"silence_id": "silence-1", "start_seconds": 3, "end_seconds": 3.6}],
        }
    )

    enriched = enrich_analysis_inputs(analysis_inputs)

    assert len(enriched.scenes) == 1
    assert enriched.scenes[0].scene_id == "scene-1"
    assert len(enriched.silences) == 1
    assert enriched.silences[0].silence_id == "silence-1"


def test_build_scene_boundaries_skips_zero_length_boundaries_after_sentence_split() -> None:
    analysis_inputs = AnalysisInputs.model_validate(
        {
            "transcript": {
                "language": "id",
                "duration_seconds": 90,
                "segments": [
                    {
                        "segment_id": "s1",
                        "start_seconds": 60.0,
                        "end_seconds": 71.0,
                        "text": "Bagian pembuka ini cukup panjang dan selesai rapi.",
                        "speaker_label": "A",
                        "words": [],
                    },
                    {
                        "segment_id": "s2",
                        "start_seconds": 71.0,
                        "end_seconds": 75.86,
                        "text": "Kalimat ini ditutup penuh supaya hard break aktif.",
                        "speaker_label": "A",
                        "words": [],
                    },
                    {
                        "segment_id": "s3",
                        "start_seconds": 75.86,
                        "end_seconds": 80.0,
                        "text": "Speaker baru lanjut dari titik yang sama.",
                        "speaker_label": "B",
                        "words": [],
                    },
                ],
            },
            "scenes": [],
            "silences": [],
        }
    )

    scenes = build_scene_boundaries(analysis_inputs.transcript, max_scene_duration_seconds=20)

    assert len(scenes) == 2
    assert scenes[0].start_seconds == 60
    assert scenes[0].end_seconds == 75.86
    assert scenes[1].start_seconds == 75.86
    assert scenes[1].end_seconds == 80
