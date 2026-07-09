from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True, slots=True)
class FfmpegCommand:
    executable: str
    arguments: tuple[str, ...]

    def as_exec_args(self) -> list[str]:
        return [self.executable, *self.arguments]


@dataclass(frozen=True, slots=True)
class ProbeSummary:
    duration_ms: int | None
    width: int | None
    height: int | None
    frame_rate: float | None
    audio_sample_rate: int | None
    codec_name: str | None
    audio_codec_name: str | None
    rotation: int | None
    has_audio: bool


def build_ffprobe_command(source: str | Path) -> FfmpegCommand:
    return FfmpegCommand(
        executable="ffprobe",
        arguments=(
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
            str(source),
        ),
    )


def build_audio_extraction(source: str | Path, destination: str | Path, sample_rate: int = 16_000) -> FfmpegCommand:
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


def build_audio_transcode(
    *,
    source: str | Path,
    destination: str | Path,
    format: str,
    sample_rate: int | None = None,
    channels: int | None = None,
) -> FfmpegCommand:
    normalized_format = format.strip().lower()
    if normalized_format not in {"wav", "mp3", "ogg"}:
        raise ValueError("unsupported audio format")
    if sample_rate is not None and sample_rate not in {8_000, 16_000, 22_050, 24_000, 44_100, 48_000}:
        raise ValueError("unsupported sample rate")
    if channels is not None and channels not in {1, 2}:
        raise ValueError("unsupported channel count")

    arguments: list[str] = [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-i",
        str(source),
    ]
    if channels is not None:
        arguments.extend(["-ac", str(channels)])
    if sample_rate is not None:
        arguments.extend(["-ar", str(sample_rate)])

    if normalized_format == "wav":
        arguments.extend(["-c:a", "pcm_s16le"])
    elif normalized_format == "mp3":
        arguments.extend(["-c:a", "libmp3lame", "-b:a", "192k"])
    else:
        arguments.extend(["-c:a", "libvorbis", "-q:a", "5"])

    arguments.append(str(destination))
    return FfmpegCommand(executable="ffmpeg", arguments=tuple(arguments))


def build_clip_render_command(
    *,
    source: str | Path,
    destination: str | Path,
    start_seconds: float,
    duration_seconds: float,
    source_width: int | None,
    source_height: int | None,
    width: int,
    height: int,
    fps: int = 30,
    video_preset: str = "medium",
    subtitle_path: str | Path | None = None,
) -> FfmpegCommand:
    if start_seconds < 0:
        raise ValueError("start_seconds must be non-negative")
    if duration_seconds <= 0:
        raise ValueError("duration_seconds must be positive")
    if width <= 0 or height <= 0:
        raise ValueError("width and height must be positive")
    if fps <= 0:
        raise ValueError("fps must be positive")
    if video_preset not in {"ultrafast", "superfast", "veryfast", "faster", "fast", "medium"}:
        raise ValueError("unsupported video preset")

    arguments: list[str] = [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-ss",
        f"{start_seconds:.3f}",
        "-t",
        f"{duration_seconds:.3f}",
        "-i",
        str(source),
    ]
    filter_graph = build_clip_filter_graph(
        source_width=source_width,
        source_height=source_height,
        target_width=width,
        target_height=height,
        fps=fps,
        subtitle_path=subtitle_path,
    )
    arguments.extend(["-vf", filter_graph])
    arguments.extend(
        [
            "-c:v",
            "libx264",
            "-preset",
            video_preset,
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            str(destination),
        ]
    )
    return FfmpegCommand(executable="ffmpeg", arguments=tuple(arguments))


def build_clip_filter_graph(
    *,
    source_width: int | None,
    source_height: int | None,
    target_width: int,
    target_height: int,
    fps: int,
    subtitle_path: str | Path | None = None,
) -> str:
    filters: list[str] = []
    crop_filter = _build_center_crop_filter(
        source_width=source_width,
        source_height=source_height,
        target_width=target_width,
        target_height=target_height,
    )
    if crop_filter:
        filters.append(crop_filter)
    filters.append(f"scale={target_width}:{target_height}")
    filters.append(f"fps={fps}")
    if subtitle_path is not None:
        filters.append(f"subtitles={subtitle_path}")
    return ",".join(filters)


def _build_center_crop_filter(
    *,
    source_width: int | None,
    source_height: int | None,
    target_width: int,
    target_height: int,
) -> str | None:
    if not source_width or not source_height:
        return None
    if source_width <= 0 or source_height <= 0:
        return None

    source_ratio = source_width / source_height
    target_ratio = target_width / target_height

    if abs(source_ratio - target_ratio) < 0.0001:
        return None

    if source_ratio > target_ratio:
        crop_width = max(2, int(round(source_height * target_ratio)))
        crop_width = min(crop_width, source_width)
        crop_width -= crop_width % 2
        x_offset = max(0, int(round((source_width - crop_width) / 2)))
        x_offset -= x_offset % 2
        return f"crop={crop_width}:{source_height}:{x_offset}:0"

    crop_height = max(2, int(round(source_width / target_ratio)))
    crop_height = min(crop_height, source_height)
    crop_height -= crop_height % 2
    y_offset = max(0, int(round((source_height - crop_height) / 2)))
    y_offset -= y_offset % 2
    return f"crop={source_width}:{crop_height}:0:{y_offset}"


def summarize_ffprobe_payload(payload: dict[str, Any]) -> ProbeSummary:
    streams = payload.get("streams")
    if not isinstance(streams, list):
        raise ValueError("ffprobe payload must contain a streams list")

    video_stream = next(
        (
            stream
            for stream in streams
            if isinstance(stream, dict) and str(stream.get("codec_type", "")).lower() == "video"
        ),
        None,
    )
    audio_stream = next(
        (
            stream
            for stream in streams
            if isinstance(stream, dict) and str(stream.get("codec_type", "")).lower() == "audio"
        ),
        None,
    )

    format_data = payload.get("format")
    if not isinstance(format_data, dict):
        format_data = {}

    duration_ms = _duration_to_ms(format_data.get("duration"))
    if duration_ms is None and isinstance(video_stream, dict):
        duration_ms = _duration_to_ms(video_stream.get("duration"))

    rotation = _extract_rotation(video_stream) if isinstance(video_stream, dict) else None

    return ProbeSummary(
        duration_ms=duration_ms,
        width=_to_int(video_stream.get("width")) if isinstance(video_stream, dict) else None,
        height=_to_int(video_stream.get("height")) if isinstance(video_stream, dict) else None,
        frame_rate=_parse_frame_rate(video_stream.get("avg_frame_rate")) if isinstance(video_stream, dict) else None,
        audio_sample_rate=_to_int(audio_stream.get("sample_rate")) if isinstance(audio_stream, dict) else None,
        codec_name=_to_str(video_stream.get("codec_name")) if isinstance(video_stream, dict) else None,
        audio_codec_name=_to_str(audio_stream.get("codec_name")) if isinstance(audio_stream, dict) else None,
        rotation=rotation,
        has_audio=audio_stream is not None,
    )


def _duration_to_ms(value: Any) -> int | None:
    if value is None:
        return None
    try:
        duration_seconds = float(str(value))
    except ValueError:
        return None
    if duration_seconds <= 0:
        return None
    return int(round(duration_seconds * 1000))


def _parse_frame_rate(value: Any) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    if "/" in value:
        numerator, denominator = value.split("/", 1)
        try:
            left = float(numerator)
            right = float(denominator)
        except ValueError:
            return None
        if right == 0:
            return None
        parsed = left / right
        return round(parsed, 4) if parsed > 0 else None
    try:
        parsed = float(value)
    except ValueError:
        return None
    return round(parsed, 4) if parsed > 0 else None


def _extract_rotation(stream: dict[str, Any] | None) -> int | None:
    if not isinstance(stream, dict):
        return None

    tags = stream.get("tags")
    if isinstance(tags, dict):
        rotation = _to_int(tags.get("rotate"))
        if rotation is not None:
            return rotation

    side_data_list = stream.get("side_data_list")
    if isinstance(side_data_list, list):
        for item in side_data_list:
            if not isinstance(item, dict):
                continue
            rotation = _to_int(item.get("rotation"))
            if rotation is not None:
                return rotation
    return None


def _to_int(value: Any) -> int | None:
    try:
        if value is None or value == "":
            return None
        return int(str(value))
    except ValueError:
        return None


def _to_str(value: Any) -> str | None:
    if value is None:
        return None
    parsed = str(value).strip()
    return parsed or None
