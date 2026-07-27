from __future__ import annotations

import io
import wave
from dataclasses import dataclass
from functools import lru_cache

from pydantic import BaseModel, Field
from temporalio.exceptions import ApplicationError

from app.application.tts_voice_profile import (
    apply_voice_profile_audio,
    build_piper_synthesis_config,
)
from app.domain.contracts import TtsSpeechSegmentsDocument
from app.domain.tts_models import get_local_tts_model


class LocalTtsRenderRequest(BaseModel):
    model_key: str = Field(min_length=1, max_length=200)
    document: TtsSpeechSegmentsDocument
    speaking_speed: float | None = Field(default=None, gt=0, le=3)


@dataclass(frozen=True, slots=True)
class LocalTtsRenderResult:
    audio_bytes: bytes
    duration_ms: int
    sample_rate: int
    channels: int
    segment_count: int
    model_key: str
    base_model_key: str
    profile_kind: str
    voice_name: str


def synthesize_local_tts_document(request: LocalTtsRenderRequest) -> LocalTtsRenderResult:
    model = get_local_tts_model(request.model_key)
    if model is None:
        raise ApplicationError(
            f"Local TTS model '{request.model_key}' is not available",
            non_retryable=True,
            type="InvalidInput",
        )

    segments = request.document.segments
    if not segments:
        raise ApplicationError(
            "At least one TTS segment is required",
            non_retryable=True,
            type="InvalidInput",
        )

    voice = _load_voice(str(model.model_path))
    synthesis_config = build_piper_synthesis_config(
        model.synthesis,
        speaking_speed=request.speaking_speed,
        is_derived_profile=model.profile_kind == "derived",
    )
    segment_wavs = [_render_segment_wav(voice, segment.text, synthesis_config) for segment in segments]
    channels, sample_width, sample_rate = _inspect_wav(segment_wavs[0])

    output_buffer = io.BytesIO()
    with wave.open(output_buffer, "wb") as destination:
        destination.setnchannels(channels)
        destination.setsampwidth(sample_width)
        destination.setframerate(sample_rate)
        destination.setcomptype("NONE", "not compressed")

        for index, segment_bytes in enumerate(segment_wavs):
            seg_channels, seg_sample_width, seg_sample_rate = _inspect_wav(segment_bytes)
            if (
                seg_channels != channels
                or seg_sample_width != sample_width
                or seg_sample_rate != sample_rate
            ):
                raise RuntimeError("Inconsistent WAV format across synthesized TTS segments")

            _append_wav_frames(segment_bytes, destination)
            pause_ms = segments[index].pause_after
            if pause_ms > 0:
                _append_silence(destination, pause_ms, sample_rate, channels, sample_width)

    audio_bytes = apply_voice_profile_audio(output_buffer.getvalue(), model.synthesis)
    channels, _, sample_rate = _inspect_wav(audio_bytes)
    duration_ms = _measure_wav_duration_ms(audio_bytes)
    return LocalTtsRenderResult(
        audio_bytes=audio_bytes,
        duration_ms=duration_ms,
        sample_rate=sample_rate,
        channels=channels,
        segment_count=len(segments),
        model_key=model.key,
        base_model_key=model.base_model_key,
        profile_kind=model.profile_kind,
        voice_name=model.display_name,
    )


def _render_segment_wav(voice: object, text: str, synthesis_config: object | None) -> bytes:
    normalized_text = text.strip()
    if not normalized_text:
        raise ApplicationError("Segment text must not be empty", non_retryable=True, type="InvalidInput")

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        if synthesis_config is None:
            voice.synthesize_wav(normalized_text, wav_file)
        else:
            voice.synthesize_wav(normalized_text, wav_file, syn_config=synthesis_config)
    return buffer.getvalue()


def _measure_wav_duration_ms(audio_bytes: bytes) -> int:
    with wave.open(io.BytesIO(audio_bytes), "rb") as wav_file:
        return round(wav_file.getnframes() / wav_file.getframerate() * 1000)


def _inspect_wav(audio_bytes: bytes) -> tuple[int, int, int]:
    with wave.open(io.BytesIO(audio_bytes), "rb") as wav_file:
        return wav_file.getnchannels(), wav_file.getsampwidth(), wav_file.getframerate()


def _append_wav_frames(audio_bytes: bytes, destination: wave.Wave_write) -> None:
    with wave.open(io.BytesIO(audio_bytes), "rb") as wav_file:
        destination.writeframes(wav_file.readframes(wav_file.getnframes()))


def _append_silence(
    destination: wave.Wave_write,
    duration_ms: int,
    sample_rate: int,
    channels: int,
    sample_width: int,
) -> None:
    frame_count = round(sample_rate * duration_ms / 1000)
    silence_frame = b"\x00" * sample_width * channels
    destination.writeframes(silence_frame * frame_count)


@lru_cache(maxsize=16)
def _load_voice(model_path: str):
    try:
        from piper import PiperVoice
    except ImportError as exc:  # pragma: no cover - dependency wiring
        raise RuntimeError(
            "piper-tts is not installed. Install the media extras before using local TTS synthesis."
        ) from exc

    return PiperVoice.load(model_path)
