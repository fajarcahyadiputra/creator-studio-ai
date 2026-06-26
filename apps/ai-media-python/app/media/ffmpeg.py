from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class FfmpegCommand:
    executable: str
    arguments: tuple[str, ...]

    def as_exec_args(self) -> list[str]:
        return [self.executable, *self.arguments]


def build_audio_extraction(source: Path, destination: Path, sample_rate: int = 16_000) -> FfmpegCommand:
    if sample_rate not in {8_000, 16_000, 44_100, 48_000}:
        raise ValueError("unsupported sample rate")
    return FfmpegCommand(
        executable="ffmpeg",
        arguments=(
            "-hide_banner",
            "-nostdin",
            "-y",
            "-i",
            str(source),
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(sample_rate),
            "-c:a",
            "pcm_s16le",
            str(destination),
        ),
    )
