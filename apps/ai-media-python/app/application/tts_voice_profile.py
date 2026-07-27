from __future__ import annotations

import io
import logging
import math
import subprocess
import wave
from pathlib import Path
from tempfile import TemporaryDirectory

from app.domain.tts_models import TtsSynthesisProfile

logger = logging.getLogger(__name__)


def build_piper_synthesis_config(
    profile: TtsSynthesisProfile,
    *,
    speaking_speed: float | None,
    is_derived_profile: bool,
) -> object | None:
    normalized_speed = speaking_speed or 1.0
    if not is_derived_profile and abs(normalized_speed - 1.0) < 0.01:
        return None

    try:
        from piper import SynthesisConfig
    except ImportError:
        return None

    effective_rate = profile.rate if is_derived_profile else 1.0
    length_scale = max(0.5, min(2.0, round(1.0 / (normalized_speed * effective_rate), 3)))
    options: dict[str, float] = {"length_scale": length_scale}
    if is_derived_profile and profile.noise_scale is not None:
        options["noise_scale"] = profile.noise_scale
    if is_derived_profile and profile.noise_w_scale is not None:
        options["noise_w_scale"] = profile.noise_w_scale
    return SynthesisConfig(**options)


def apply_voice_profile_audio(audio_bytes: bytes, profile: TtsSynthesisProfile) -> bytes:
    pitch = max(-6.0, min(6.0, profile.pitch_semitones))
    volume = max(0.5, min(1.5, profile.volume))
    if abs(pitch) < 0.01 and abs(volume - 1.0) < 0.01:
        return audio_bytes

    with TemporaryDirectory(prefix="creator-tts-profile-") as temporary_directory:
        source_path = Path(temporary_directory) / "source.wav"
        output_path = Path(temporary_directory) / "profiled.wav"
        source_path.write_bytes(audio_bytes)
        filters = _build_audio_filters(pitch, volume, _sample_rate(audio_bytes))
        command = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(source_path),
            "-af",
            filters,
            "-c:a",
            "pcm_s16le",
            str(output_path),
        ]
        try:
            completed = subprocess.run(command, capture_output=True, check=False, timeout=60)
        except (OSError, subprocess.TimeoutExpired) as exc:
            logger.warning("TTS voice profile audio processing failed; using original audio", exc_info=exc)
            return audio_bytes

        if completed.returncode != 0 or not output_path.is_file():
            logger.warning(
                "TTS voice profile audio processing returned an error; using original audio",
                extra={
                    "return_code": completed.returncode,
                    "stderr": completed.stderr.decode(errors="replace")[-500:],
                },
            )
            return audio_bytes
        return output_path.read_bytes()


def _sample_rate(audio_bytes: bytes) -> int:
    with wave.open(io.BytesIO(audio_bytes), "rb") as wav_file:
        return wav_file.getframerate()


def _build_audio_filters(pitch_semitones: float, volume: float, sample_rate: int) -> str:
    filters: list[str] = []
    if abs(pitch_semitones) >= 0.01:
        ratio = math.pow(2.0, pitch_semitones / 12.0)
        filters.extend(
            [
                f"asetrate={sample_rate}*{ratio:.8f}",
                f"aresample={sample_rate}",
                f"atempo={1.0 / ratio:.8f}",
            ]
        )
    if abs(volume - 1.0) >= 0.01:
        filters.append(f"volume={volume:.4f}")
    return ",".join(filters) or "anull"
