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
    layout_template: str | None = None,
    layout_options: dict[str, Any] | None = None,
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

    if layout_template == "PODCAST_SPOTLIGHT_9X16":
        return _build_podcast_spotlight_render_command(
            source=source,
            destination=destination,
            start_seconds=start_seconds,
            duration_seconds=duration_seconds,
            source_width=source_width,
            source_height=source_height,
            width=width,
            height=height,
            fps=fps,
            video_preset=video_preset,
            subtitle_path=subtitle_path,
            layout_options=layout_options or {},
        )

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


def _build_podcast_spotlight_render_command(
    *,
    source: str | Path,
    destination: str | Path,
    start_seconds: float,
    duration_seconds: float,
    source_width: int | None,
    source_height: int | None,
    width: int,
    height: int,
    fps: int,
    video_preset: str,
    subtitle_path: str | Path | None,
    layout_options: dict[str, Any],
) -> FfmpegCommand:
    logo_source = layout_options.get("logo_source")
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
    if isinstance(logo_source, str) and logo_source.strip():
        arguments.extend(["-i", logo_source.strip()])

    filter_graph = _build_podcast_spotlight_filter_graph(
        source_width=source_width,
        source_height=source_height,
        target_width=width,
        target_height=height,
        fps=fps,
        subtitle_path=subtitle_path,
        layout_options=layout_options,
        include_logo_input=isinstance(logo_source, str) and bool(logo_source.strip()),
    )
    arguments.extend(
        [
            "-filter_complex",
            filter_graph,
            "-map",
            "[vout]",
            "-map",
            "0:a?",
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
            "-shortest",
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


def _build_podcast_spotlight_filter_graph(
    *,
    source_width: int | None,
    source_height: int | None,
    target_width: int,
    target_height: int,
    fps: int,
    subtitle_path: str | Path | None,
    layout_options: dict[str, Any],
    include_logo_input: bool,
) -> str:
    panel_width = 930
    panel_height = 690
    panel_x = 75
    panel_y = 540
    crop_filter = _build_center_crop_filter(
        source_width=source_width,
        source_height=source_height,
        target_width=panel_width,
        target_height=panel_height,
    )
    video_filters = [part for part in [crop_filter, f"scale={panel_width}:{panel_height}", f"fps={fps}"] if part]
    graph_parts = [
        f"color=c=0x05070d:s={target_width}x{target_height}:d=1[base]",
        f"[0:v]{','.join(video_filters)}[clip]",
        "[base]drawbox=x=0:y=0:w=iw:h=ih:color=0x04060c:t=fill[bg0]",
        "[bg0]drawbox=x=0:y=0:w=iw:h=ih:color=0x0b1220@0.22:t=18[bg1]",
        "[bg1]drawbox=x=270:y=134:w=540:h=4:color=0xf6c343@0.95:t=fill[bg2]",
        "[bg2]drawbox=x=120:y=332:w=840:h=3:color=0xf6c343@0.75:t=fill[bg3]",
        f"[bg3]drawbox=x={panel_x - 10}:y={panel_y - 10}:w={panel_width + 20}:h={panel_height + 20}:color=0xf6c343@0.92:t=3[panel0]",
        f"[panel0]drawbox=x={panel_x}:y={panel_y}:w={panel_width}:h={panel_height}:color=0x111827@0.98:t=fill[panel1]",
        f"[panel1][clip]overlay={panel_x}:{panel_y}[canvas0]",
        "[canvas0]drawbox=x=118:y=1298:w=844:h=252:color=0x0d1422@0.94:t=fill[quotebox0]",
        "[quotebox0]drawbox=x=118:y=1298:w=844:h=252:color=white@0.10:t=2[quotebox1]",
        "[quotebox1]drawbox=x=370:y=1788:w=340:h=54:color=0x0d1422@0.98:t=fill[sourcebar0]",
        "[sourcebar0]drawbox=x=370:y=1788:w=340:h=54:color=0xf6c343@0.70:t=2[sourcebar1]",
    ]

    current_label = "sourcebar1"
    if include_logo_input:
        graph_parts.append("[1:v]scale=120:120[logo]")
        graph_parts.append(f"[{current_label}][logo]overlay=220:52[canvas1]")
        current_label = "canvas1"

    current_label = _append_textfile_draw(
        graph_parts,
        current_label,
        layout_options.get("channel_name_file"),
        font_size=_resolve_font_size(layout_options.get("channel_name_size"), 32),
        x="360",
        y=70,
        font_color="white@0.97",
        output_label="canvas2",
    )
    current_label = _append_textfile_draw(
        graph_parts,
        current_label,
        layout_options.get("channel_tagline_file"),
        font_size=_resolve_font_size(layout_options.get("channel_tagline_size"), 24),
        x="360",
        y=112,
        font_color="0xf6c343@0.97",
        output_label="canvas3",
    )
    current_label = _append_textfile_draw(
        graph_parts,
        current_label,
        layout_options.get("headline_file"),
        font_size=_resolve_font_size(layout_options.get("headline_size"), 96),
        x="(w-text_w)/2",
        y=170,
        font_color="white@0.98",
        line_spacing=12,
        output_label="canvas4",
    )
    current_label = _append_textfile_draw(
        graph_parts,
        current_label,
        layout_options.get("quote_file"),
        font_size=44,
        x="(w-text_w)/2",
        y=1380,
        font_color="white@0.98",
        line_spacing=14,
        output_label="canvas5",
    )
    graph_parts.append(
        f"[{current_label}]drawtext=text='“':fontcolor=0xf6c343@0.98:fontsize=112:x=(w-text_w)/2:y=1298[canvas6]"
    )
    current_label = "canvas6"
    current_label = _append_textfile_draw(
        graph_parts,
        current_label,
        layout_options.get("source_label_file"),
        font_size=_resolve_font_size(layout_options.get("source_label_size"), 28),
        x="(w-text_w)/2",
        y=1800,
        font_color="0xf6c343@0.97",
        output_label="canvas7",
    )

    # This poster-style layout uses its own quote card under the video.
    # Sidecar subtitles are still generated and uploaded separately, but we avoid
    # burning default full-frame subtitles because they visually fight the layout.
    graph_parts.append(f"[{current_label}]null[vout]")

    return ";".join(graph_parts)


def _append_textfile_draw(
    graph_parts: list[str],
    input_label: str,
    textfile: Any,
    *,
    font_size: int,
    x: str,
    y: int,
    font_color: str,
    output_label: str,
    line_spacing: int = 12,
    box: int = 0,
    box_color: str = "black@0.0",
    box_borderw: int = 0,
) -> str:
    if not isinstance(textfile, (str, Path)) or not str(textfile).strip():
        return input_label
    escaped_path = _escape_filter_value(textfile)
    graph_parts.append(
        f"[{input_label}]drawtext=textfile='{escaped_path}':fontcolor={font_color}:fontsize={font_size}:x={x}:y={y}:line_spacing={line_spacing}:box={box}:boxcolor={box_color}:boxborderw={box_borderw}[{output_label}]"
    )
    return output_label


def _resolve_font_size(value: Any, fallback: int) -> int:
    if isinstance(value, int) and value > 0:
        return value
    return fallback


def _escape_filter_value(value: str | Path) -> str:
    return (
        str(value)
        .replace("\\", "\\\\")
        .replace(":", r"\:")
        .replace(",", r"\,")
        .replace("'", r"\'")
        .replace("[", r"\[")
        .replace("]", r"\]")
    )


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
