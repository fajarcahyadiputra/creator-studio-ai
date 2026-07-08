from __future__ import annotations

import io
import wave
from functools import lru_cache

from pydantic import BaseModel, Field
from temporalio.exceptions import ApplicationError

from app.config import get_settings
from app.domain.tts_models import LocalTtsModel, get_local_tts_model


class LocalTtsPreviewRequest(BaseModel):
    model_key: str = Field(min_length=1, max_length=200)
    text: str = Field(min_length=1, max_length=500)


def synthesize_local_tts_preview(request: LocalTtsPreviewRequest) -> bytes:
    model = get_local_tts_model(request.model_key)
    if model is None:
        raise ApplicationError(
            f"Local TTS model '{request.model_key}' is not available",
            non_retryable=True,
            type="InvalidInput",
        )

    normalized_text = request.text.strip()
    if not normalized_text:
        raise ApplicationError("Preview text is required", non_retryable=True, type="InvalidInput")

    voice = _load_voice(str(model.model_path))
    buffer = io.BytesIO()

    with wave.open(buffer, "wb") as wav_file:
        voice.synthesize_wav(normalized_text, wav_file)

    return buffer.getvalue()


def default_preview_text(model: LocalTtsModel | None) -> str:
    settings = get_settings()
    default_text = settings.TTS_SAMPLE_TEXT.strip()
    if model is None:
        return default_text

    language = model.language_code.lower()
    if language.startswith("id_"):
        return default_text
    if language.startswith("en_"):
        return "Hello, this is a sample voice preview for your narration workflow."
    return default_text


@lru_cache(maxsize=16)
def _load_voice(model_path: str):
    try:
        from piper import PiperVoice
    except ImportError as exc:  # pragma: no cover - dependency wiring
        raise RuntimeError(
            "piper-tts is not installed. Install the media extras before using local TTS previews."
        ) from exc

    return PiperVoice.load(model_path)
