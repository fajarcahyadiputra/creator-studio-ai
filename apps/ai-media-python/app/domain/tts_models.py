from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.config import get_settings


@dataclass(frozen=True, slots=True)
class TtsSynthesisProfile:
    rate: float = 1.0
    pitch_semitones: float = 0.0
    noise_scale: float | None = None
    noise_w_scale: float | None = None
    volume: float = 1.0


@dataclass(frozen=True, slots=True)
class LocalTtsModel:
    key: str
    model_path: Path
    config_path: Path
    language_code: str
    voice_name: str
    quality: str | None
    sample_rate: int | None
    speaker_count: int | None
    phoneme_type: str | None
    dataset: str | None
    base_model_key: str
    profile_kind: str
    display_name: str
    description: str | None
    gender: str | None
    age_group: str | None
    character: str | None
    intonation: str | None
    speaking_style: str | None
    sample_text: str | None
    license_name: str | None
    license_url: str | None
    synthesis: TtsSynthesisProfile


def list_local_tts_models(
    *,
    model_dir: Path | None = None,
    catalog_path: Path | None = None,
) -> list[LocalTtsModel]:
    resolved_model_dir = model_dir or Path(get_settings().TTS_MODEL_DIR)
    if not resolved_model_dir.exists() or not resolved_model_dir.is_dir():
        return []

    checkpoints = [
        model
        for model_path in sorted(resolved_model_dir.glob("*.onnx"))
        if (model := _build_checkpoint_model(model_path)) is not None
    ]
    checkpoints_by_key = {model.key: model for model in checkpoints}
    profiles = _load_profiles(catalog_path)
    derived = [
        model
        for profile in profiles
        if (model := _build_profile_model(profile, checkpoints_by_key)) is not None
    ]
    return [*derived, *checkpoints]


def get_local_tts_model(
    model_key: str,
    *,
    model_dir: Path | None = None,
    catalog_path: Path | None = None,
) -> LocalTtsModel | None:
    normalized = model_key.strip()
    if not normalized:
        return None
    for model in list_local_tts_models(model_dir=model_dir, catalog_path=catalog_path):
        if model.key == normalized:
            return model
    return None


def _build_checkpoint_model(model_path: Path) -> LocalTtsModel | None:
    base_name = model_path.stem
    parts = base_name.split("-")
    if len(parts) < 2:
        return None

    config_path = model_path.with_suffix(model_path.suffix + ".json")
    metadata = _load_json(config_path)
    voice_name = "-".join(parts[1:])
    return LocalTtsModel(
        key=base_name,
        model_path=model_path,
        config_path=config_path,
        language_code=parts[0],
        voice_name=voice_name,
        quality=_as_optional_string(metadata.get("audio", {}).get("quality")) or _infer_quality(base_name),
        sample_rate=_as_optional_int(metadata.get("audio", {}).get("sample_rate")),
        speaker_count=_as_optional_int(metadata.get("num_speakers")),
        phoneme_type=_as_optional_string(metadata.get("phoneme_type")),
        dataset=_as_optional_string(metadata.get("dataset")),
        base_model_key=base_name,
        profile_kind="checkpoint",
        display_name=voice_name.replace("-", " ").replace("_", " ").title(),
        description="Local Piper checkpoint without derived profile tuning.",
        gender=None,
        age_group=None,
        character=None,
        intonation=None,
        speaking_style=None,
        sample_text=None,
        license_name=None,
        license_url=None,
        synthesis=TtsSynthesisProfile(),
    )


def _build_profile_model(
    profile: dict[str, Any],
    checkpoints_by_key: dict[str, LocalTtsModel],
) -> LocalTtsModel | None:
    key = _as_optional_string(profile.get("key"))
    model_key = _as_optional_string(profile.get("model_key"))
    display_name = _as_optional_string(profile.get("display_name"))
    language_code = _as_optional_string(profile.get("language_code"))
    if not key or not model_key or not display_name or not language_code:
        return None

    checkpoint = checkpoints_by_key.get(model_key)
    if checkpoint is None:
        return None

    license_data = profile.get("license") if isinstance(profile.get("license"), dict) else {}
    synthesis_data = profile.get("synthesis") if isinstance(profile.get("synthesis"), dict) else {}
    return LocalTtsModel(
        key=key,
        model_path=checkpoint.model_path,
        config_path=checkpoint.config_path,
        language_code=language_code,
        voice_name=display_name,
        quality=checkpoint.quality,
        sample_rate=checkpoint.sample_rate,
        speaker_count=checkpoint.speaker_count,
        phoneme_type=checkpoint.phoneme_type,
        dataset=checkpoint.dataset,
        base_model_key=model_key,
        profile_kind="derived",
        display_name=display_name,
        description=_as_optional_string(profile.get("description")),
        gender=_as_optional_string(profile.get("gender")),
        age_group=_as_optional_string(profile.get("age")),
        character=_as_optional_string(profile.get("character")),
        intonation=_as_optional_string(profile.get("intonation")),
        speaking_style=_as_optional_string(profile.get("speaking_style")),
        sample_text=_as_optional_string(profile.get("sample_text")),
        license_name=_as_optional_string(license_data.get("name")),
        license_url=_as_optional_string(license_data.get("url")),
        synthesis=TtsSynthesisProfile(
            rate=_bounded_float(synthesis_data.get("rate"), default=1.0, minimum=0.5, maximum=2.0),
            pitch_semitones=_bounded_float(
                synthesis_data.get("pitch_semitones"),
                default=0.0,
                minimum=-6.0,
                maximum=6.0,
            ),
            noise_scale=_optional_bounded_float(synthesis_data.get("noise_scale"), 0.0, 2.0),
            noise_w_scale=_optional_bounded_float(synthesis_data.get("noise_w_scale"), 0.0, 2.0),
            volume=_bounded_float(synthesis_data.get("volume"), default=1.0, minimum=0.5, maximum=1.5),
        ),
    )


def _load_profiles(explicit_path: Path | None) -> list[dict[str, Any]]:
    catalog_path = explicit_path or _find_catalog_path()
    if catalog_path is None:
        return []
    catalog = _load_json(catalog_path)
    profiles = catalog.get("profiles")
    if not isinstance(profiles, list):
        return []
    return [profile for profile in profiles if isinstance(profile, dict)]


def _find_catalog_path() -> Path | None:
    source_file = Path(__file__).resolve()
    catalog_suffix = Path("packages/contracts/json-schema/tts-voice-profiles.json")
    candidates = [
        Path.cwd() / catalog_suffix,
        *(parent / catalog_suffix for parent in source_file.parents),
    ]
    for candidate in dict.fromkeys(candidates):
        if candidate.is_file():
            return candidate
    return None


def _load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def _infer_quality(value: str) -> str | None:
    lowered = value.lower()
    if "high" in lowered:
        return "high"
    if "medium" in lowered:
        return "medium"
    if "low" in lowered:
        return "low"
    return None


def _as_optional_string(value: Any) -> str | None:
    if isinstance(value, str):
        stripped = value.strip()
        if stripped:
            return stripped
    return None


def _as_optional_int(value: Any) -> int | None:
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def _bounded_float(value: Any, *, default: float, minimum: float, maximum: float) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return max(minimum, min(maximum, float(value)))
    return default


def _optional_bounded_float(value: Any, minimum: float, maximum: float) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return max(minimum, min(maximum, float(value)))
    return None
