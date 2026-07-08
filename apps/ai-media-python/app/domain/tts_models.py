from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.config import get_settings


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


def list_local_tts_models() -> list[LocalTtsModel]:
    model_dir = Path(get_settings().TTS_MODEL_DIR)
    if not model_dir.exists() or not model_dir.is_dir():
        return []

    models: list[LocalTtsModel] = []
    for model_path in sorted(model_dir.glob("*.onnx")):
        summary = _build_model(model_path)
        if summary is not None:
            models.append(summary)
    return models


def get_local_tts_model(model_key: str) -> LocalTtsModel | None:
    normalized = model_key.strip()
    if not normalized:
        return None
    for model in list_local_tts_models():
        if model.key == normalized:
            return model
    return None


def _build_model(model_path: Path) -> LocalTtsModel | None:
    base_name = model_path.stem
    parts = base_name.split("-")
    if len(parts) < 2:
        return None

    config_path = model_path.with_suffix(model_path.suffix + ".json")
    metadata = _load_metadata(config_path)
    return LocalTtsModel(
        key=base_name,
        model_path=model_path,
        config_path=config_path,
        language_code=parts[0],
        voice_name="-".join(parts[1:]),
        quality=_as_optional_string(metadata.get("audio", {}).get("quality")) or _infer_quality(base_name),
        sample_rate=_as_optional_int(metadata.get("audio", {}).get("sample_rate")),
        speaker_count=_as_optional_int(metadata.get("num_speakers")),
        phoneme_type=_as_optional_string(metadata.get("phoneme_type")),
        dataset=_as_optional_string(metadata.get("dataset")),
    )


def _load_metadata(config_path: Path) -> dict[str, Any]:
    try:
        return json.loads(config_path.read_text(encoding="utf-8"))
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
