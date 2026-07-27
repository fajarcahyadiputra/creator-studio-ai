from __future__ import annotations

import io
import json
import unittest
import wave
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from app.application import local_tts_preview, tts_voice_profile
from app.domain import tts_models
from app.domain.tts_models import (
    LocalTtsModel,
    TtsSynthesisProfile,
    get_local_tts_model,
    list_local_tts_models,
)


class TtsModelTests(unittest.TestCase):
    def test_catalog_discovery_handles_shallow_container_source_path(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            catalog_path = root / "packages/contracts/json-schema/tts-voice-profiles.json"
            catalog_path.parent.mkdir(parents=True)
            catalog_path.write_text('{"profiles":[]}', encoding="utf-8")

            with (
                patch.object(tts_models, "__file__", "/app/app/domain/tts_models.py"),
                patch.object(tts_models.Path, "cwd", return_value=root),
            ):
                resolved = tts_models._find_catalog_path()

            self.assertEqual(resolved, catalog_path)

    def test_voice_profiles_resolve_to_installed_checkpoint_and_keep_legacy_key(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            model_dir = root / "models"
            model_dir.mkdir()
            model_path = model_dir / "id_ID-news_tts-medium.onnx"
            model_path.write_bytes(b"model")
            model_path.with_suffix(".onnx.json").write_text(
                json.dumps(
                    {
                        "audio": {"sample_rate": 22050, "quality": "medium"},
                        "dataset": "news_tts",
                        "num_speakers": 1,
                    }
                ),
                encoding="utf-8",
            )
            catalog_path = root / "catalog.json"
            catalog_path.write_text(
                json.dumps(
                    {
                        "profiles": [
                            {
                                "key": "id-test-warm",
                                "model_key": "id_ID-news_tts-medium",
                                "display_name": "Test Warm",
                                "language_code": "id_ID",
                                "gender": "female",
                                "age": "adult",
                                "character": "warm",
                                "intonation": "natural",
                                "speaking_style": "storytelling",
                                "description": "Warm profile",
                                "sample_text": "Halo dari profil.",
                                "synthesis": {
                                    "rate": 0.95,
                                    "pitch_semitones": 2.0,
                                    "noise_scale": 0.6,
                                    "noise_w_scale": 0.7,
                                    "volume": 1.0,
                                },
                            },
                            {
                                "key": "id-missing",
                                "model_key": "id_ID-missing-medium",
                                "display_name": "Missing",
                                "language_code": "id_ID",
                            },
                        ]
                    }
                ),
                encoding="utf-8",
            )

            models = list_local_tts_models(model_dir=model_dir, catalog_path=catalog_path)

            self.assertEqual(
                [model.key for model in models],
                ["id-test-warm", "id_ID-news_tts-medium"],
            )
            profile = get_local_tts_model(
                "id-test-warm",
                model_dir=model_dir,
                catalog_path=catalog_path,
            )
            self.assertIsNotNone(profile)
            assert profile is not None
            self.assertEqual(profile.model_path, model_path)
            self.assertEqual(profile.base_model_key, "id_ID-news_tts-medium")
            self.assertEqual(profile.profile_kind, "derived")
            self.assertEqual(profile.gender, "female")
            self.assertEqual(profile.synthesis.pitch_semitones, 2.0)

            legacy = get_local_tts_model(
                "id_ID-news_tts-medium",
                model_dir=model_dir,
                catalog_path=catalog_path,
            )
            self.assertIsNotNone(legacy)
            assert legacy is not None
            self.assertEqual(legacy.profile_kind, "checkpoint")
            self.assertEqual(legacy.synthesis, TtsSynthesisProfile())

    def test_voice_profile_audio_falls_back_to_original_when_ffmpeg_fails(self) -> None:
        original = _silent_wav()
        with patch.object(
            tts_voice_profile.subprocess,
            "run",
            return_value=SimpleNamespace(returncode=1, stderr=b"failure"),
        ):
            result = tts_voice_profile.apply_voice_profile_audio(
                original,
                TtsSynthesisProfile(pitch_semitones=2.0),
            )

        self.assertEqual(result, original)

    def test_preview_synthesizes_short_audio_directly_without_workflow(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            model = LocalTtsModel(
                key="id-test-warm",
                model_path=root / "model.onnx",
                config_path=root / "model.onnx.json",
                language_code="id_ID",
                voice_name="Test Warm",
                quality="medium",
                sample_rate=22050,
                speaker_count=1,
                phoneme_type=None,
                dataset="news_tts",
                base_model_key="id_ID-news_tts-medium",
                profile_kind="derived",
                display_name="Test Warm",
                description="Warm test profile",
                gender="female",
                age_group="adult",
                character="warm",
                intonation="natural",
                speaking_style="storytelling",
                sample_text="Halo dari profil.",
                license_name=None,
                license_url=None,
                synthesis=TtsSynthesisProfile(),
            )
            calls: list[str] = []

            class FakeVoice:
                def synthesize_wav(self, text, wav_file, **_kwargs) -> None:
                    calls.append(text)
                    wav_file.setnchannels(1)
                    wav_file.setsampwidth(2)
                    wav_file.setframerate(22050)
                    wav_file.writeframes(b"\x00\x00" * 220)

            with (
                patch.object(local_tts_preview, "get_local_tts_model", return_value=model),
                patch.object(local_tts_preview, "_load_voice", return_value=FakeVoice()),
                patch.object(
                    local_tts_preview,
                    "apply_voice_profile_audio",
                    side_effect=lambda audio, _profile: audio,
                ),
            ):
                result = local_tts_preview.synthesize_local_tts_preview(
                    local_tts_preview.LocalTtsPreviewRequest(
                        model_key="id-test-warm",
                        text="Preview singkat.",
                    )
                )

            self.assertEqual(calls, ["Preview singkat."])
            self.assertTrue(result.startswith(b"RIFF"))


def _silent_wav() -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(22050)
        wav_file.writeframes(b"\x00\x00" * 220)
    return buffer.getvalue()


if __name__ == "__main__":
    unittest.main()
