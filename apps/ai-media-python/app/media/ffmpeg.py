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
    crop_strategy: str = "AUTO_REFRAME",
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
            crop_strategy=crop_strategy,
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
        crop_strategy=crop_strategy,
        layout_options=layout_options or {},
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
    crop_strategy: str,
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
        crop_strategy=crop_strategy,
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
    crop_strategy: str = "AUTO_REFRAME",
    layout_options: dict[str, Any] | None = None,
) -> str:
    normalized_strategy = str(crop_strategy or "AUTO_REFRAME").strip().upper()
    normalized_options = layout_options or {}
    filters: list[str] = []
    crop_filter = _build_strategy_crop_filter(
        source_width=source_width,
        source_height=source_height,
        target_width=target_width,
        target_height=target_height,
        crop_strategy=normalized_strategy,
        layout_options=normalized_options,
    )
    if crop_filter:
        filters.append(crop_filter)
    filters.append(f"scale={target_width}:{target_height}")
    filters.append(f"fps={fps}")
    if subtitle_path is not None:
        escaped_subtitle = _escape_filter_value(subtitle_path)
        filters.append(f"subtitles='{escaped_subtitle}'")
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
    crop_strategy: str,
) -> str:
    panel_width = 924
    panel_height = 520
    panel_x = 78
    panel_y = 646
    normalized_strategy = str(crop_strategy or layout_options.get("crop_strategy") or "AUTO_REFRAME").strip().upper()
    split_frame_enabled = bool(layout_options.get("split_frame_enabled")) or normalized_strategy in {
        "SPLIT_SCREEN",
        "SPEAKER_AND_SCREEN",
    }
    graph_parts: list[str] = []

    if split_frame_enabled:
        left_width = panel_width // 2
        right_width = panel_width - left_width
        left_anchor_ratio, right_anchor_ratio = _resolve_split_anchor_ratios(layout_options)
        left_crop = _build_region_crop_filter(
            source_width=source_width,
            source_height=source_height,
            target_width=left_width,
            target_height=panel_height,
            anchor=left_anchor_ratio,
        )
        right_crop = _build_region_crop_filter(
            source_width=source_width,
            source_height=source_height,
            target_width=right_width,
            target_height=panel_height,
            anchor=right_anchor_ratio,
        )
        left_chain = ",".join(
            [part for part in [left_crop, f"scale={left_width}:{panel_height}", f"fps={fps}"] if part]
        )
        right_chain = ",".join(
            [part for part in [right_crop, f"scale={right_width}:{panel_height}", f"fps={fps}"] if part]
        )
        graph_parts.extend(
            [
                f"[0:v]{left_chain}[clip_left]",
                f"[0:v]{right_chain}[clip_right]",
                "[clip_left][clip_right]hstack=inputs=2[clip]",
            ]
        )
    else:
        crop_filter = _build_strategy_crop_filter(
            source_width=source_width,
            source_height=source_height,
            target_width=panel_width,
            target_height=panel_height,
            crop_strategy=normalized_strategy,
            layout_options=layout_options,
        )
        video_filters = [part for part in [crop_filter, f"scale={panel_width}:{panel_height}", f"fps={fps}"] if part]
        graph_parts.append(f"[0:v]{','.join(video_filters)}[clip]")

    graph_parts.extend(
        [
            f"color=c=0x05070d:s={target_width}x{target_height}:d=1[base]",
            "[base]drawbox=x=0:y=0:w=iw:h=ih:color=0x04060c:t=fill[bg0]",
            "[bg0]drawbox=x=0:y=0:w=iw:h=ih:color=0x0b1220@0.12:t=22[bg1]",
            "[bg1]drawbox=x=0:y=0:w=iw:h=ih:color=0x0b1220@0.06:t=60[bg2]",
            "[bg2]drawbox=x=172:y=546:w=268:h=3:color=0xf6c343@0.86:t=fill[bg3]",
            f"[bg3]drawbox=x={panel_x - 14}:y={panel_y - 14}:w={panel_width + 28}:h={panel_height + 28}:color=0x000000@0.26:t=fill[panel_shadow]",
            f"[panel_shadow]drawbox=x={panel_x - 2}:y={panel_y - 2}:w={panel_width + 4}:h={panel_height + 4}:color=0xf6c343@0.82:t=2[panel0]",
            f"[panel0]drawbox=x={panel_x}:y={panel_y}:w={panel_width}:h={panel_height}:color=0x101724@0.98:t=fill[panel1]",
            f"[panel1][clip]overlay={panel_x}:{panel_y}[canvas0]",
            "[canvas0]drawbox=x=344:y=1750:w=392:h=56:color=0x0b1020@0.98:t=fill[sourcebar0]",
            "[sourcebar0]drawbox=x=344:y=1750:w=392:h=56:color=0xf6c343@0.42:t=1[sourcebar1]",
        ]
    )

    current_label = "sourcebar1"
    if include_logo_input:
        graph_parts.append("[1:v]scale=86:86,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte((X-W/2)*(X-W/2)+(Y-H/2)*(Y-H/2),(W/2)*(H/2)),255,0)'[logo]")
        graph_parts.append("[sourcebar1][logo]overlay=126:98[canvas1]")
        current_label = "canvas1"

    graph_parts.append(f"[{current_label}]drawbox=x=242:y=108:w=2:h=72:color=0xf6c343@0.82:t=fill[brandline]")
    current_label = "brandline"
    current_label = _append_textfile_draw(
        graph_parts,
        current_label,
        layout_options.get("channel_name_file"),
        font_size=_resolve_font_size(layout_options.get("channel_name_size"), 28),
        x="270",
        y=102,
        font_color="white@0.97",
        output_label="canvas2",
    )
    current_label = _append_textfile_draw(
        graph_parts,
        current_label,
        layout_options.get("channel_tagline_file"),
        font_size=_resolve_font_size(layout_options.get("channel_tagline_size"), 20),
        x="270",
        y=140,
        font_color="0xf6c343@0.97",
        output_label="canvas3",
    )
    current_label = _append_textfile_draw(
        graph_parts,
        current_label,
        layout_options.get("headline_primary_file"),
        font_size=_resolve_font_size(layout_options.get("headline_primary_size"), 72),
        x="142",
        y=_resolve_font_size(layout_options.get("headline_primary_y"), 220),
        font_color="white@0.98",
        line_spacing=2,
        output_label="canvas4",
    )
    current_label = _append_textfile_draw(
        graph_parts,
        current_label,
        layout_options.get("headline_emphasis_file"),
        font_size=_resolve_font_size(layout_options.get("headline_emphasis_size"), 82),
        x="142",
        y=_resolve_font_size(layout_options.get("headline_emphasis_y"), 366),
        font_color="0xf6c343@0.99",
        line_spacing=0,
        output_label="canvas5",
    )
    graph_parts.append(
        f"[{current_label}]drawbox=x=136:y={_resolve_font_size(layout_options.get('headline_divider_y'), 520)}:w=684:h=3:color=0xf6c343@0.78:t=fill[canvas6]"
    )
    graph_parts.append("[canvas6]drawbox=x=252:y=1278:w=576:h=3:color=0xf6c343@0.56:t=fill[canvas7]")
    current_label = "canvas7"
    current_label = _append_textfile_draw(
        graph_parts,
        current_label,
        layout_options.get("source_label_file"),
        font_size=_resolve_font_size(layout_options.get("source_label_size"), 22),
        x="(w-text_w)/2",
        y=1764,
        font_color="0xf6c343@0.97",
        output_label="canvas8",
    )

    if subtitle_path is not None:
        escaped_subtitle = _escape_filter_value(subtitle_path)
        graph_parts.append(f"[{current_label}]subtitles='{escaped_subtitle}'[vout]")
    else:
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


def _build_strategy_crop_filter(
    *,
    source_width: int | None,
    source_height: int | None,
    target_width: int,
    target_height: int,
    crop_strategy: str,
    layout_options: dict[str, Any],
) -> str | None:
    normalized_strategy = str(crop_strategy or "AUTO_REFRAME").strip().upper()
    speaker_count = layout_options.get("speaker_count")
    has_multiple_speakers = isinstance(speaker_count, int) and speaker_count >= 2

    if normalized_strategy == "ACTIVE_SPEAKER" or (
        normalized_strategy == "AUTO_REFRAME" and has_multiple_speakers
    ):
        return _build_active_speaker_crop_filter(
            source_width=source_width,
            source_height=source_height,
            target_width=target_width,
            target_height=target_height,
            layout_options=layout_options,
        )
    if normalized_strategy in {"SPLIT_SCREEN", "SPEAKER_AND_SCREEN"}:
        return _build_active_speaker_crop_filter(
            source_width=source_width,
            source_height=source_height,
            target_width=target_width,
            target_height=target_height,
            layout_options=layout_options,
        )
    if normalized_strategy == "FACE_TRACKING":
        return _build_face_tracking_crop_filter(
            source_width=source_width,
            source_height=source_height,
            target_width=target_width,
            target_height=target_height,
            layout_options=layout_options,
        )
    if normalized_strategy == "AUTO_REFRAME":
        return _build_face_tracking_crop_filter(
            source_width=source_width,
            source_height=source_height,
            target_width=target_width,
            target_height=target_height,
            layout_options=layout_options,
        ) or _build_center_crop_filter(
            source_width=source_width,
            source_height=source_height,
            target_width=target_width,
            target_height=target_height,
        )
    return _build_center_crop_filter(
        source_width=source_width,
        source_height=source_height,
        target_width=target_width,
        target_height=target_height,
    )


def _build_face_tracking_crop_filter(
    *,
    source_width: int | None,
    source_height: int | None,
    target_width: int,
    target_height: int,
    layout_options: dict[str, Any],
) -> str | None:
    face_layout_summary = layout_options.get("face_layout_summary")
    if not isinstance(face_layout_summary, dict):
        return None
    anchor = face_layout_summary.get("single_face_anchor")
    if anchor not in {"left", "center", "right"}:
        return None
    return _build_region_crop_filter(
        source_width=source_width,
        source_height=source_height,
        target_width=target_width,
        target_height=target_height,
        anchor=str(anchor),
    )


def _build_active_speaker_crop_filter(
    *,
    source_width: int | None,
    source_height: int | None,
    target_width: int,
    target_height: int,
    layout_options: dict[str, Any],
) -> str | None:
    if not source_width or not source_height:
        return None

    crop_width, crop_height = _resolve_crop_dimensions(
        source_width=source_width,
        source_height=source_height,
        target_width=target_width,
        target_height=target_height,
    )
    if crop_width is None or crop_height is None:
        return None

    if crop_width >= source_width:
        return _build_center_crop_filter(
            source_width=source_width,
            source_height=source_height,
            target_width=target_width,
            target_height=target_height,
        )

    active_strategy = layout_options.get("active_speaker_strategy")
    if not isinstance(active_strategy, dict):
        return _build_center_crop_filter(
            source_width=source_width,
            source_height=source_height,
            target_width=target_width,
            target_height=target_height,
        )

    speaker_order = active_strategy.get("speaker_order")
    windows = active_strategy.get("windows")
    if not isinstance(speaker_order, list) or len(speaker_order) < 2 or not isinstance(windows, list):
        return _build_center_crop_filter(
            source_width=source_width,
            source_height=source_height,
            target_width=target_width,
            target_height=target_height,
        )

    left_x = 0
    center_x = max(0, ((source_width - crop_width) // 2) // 2 * 2)
    right_x = max(0, ((source_width - crop_width)) // 2 * 2)
    speaker_to_x = {
        str(speaker_order[0]): left_x,
        str(speaker_order[1]): right_x,
    }

    expression = str(center_x)
    for window in reversed(windows):
        speaker_label = window.get("speaker_label")
        start_seconds = window.get("start_seconds")
        end_seconds = window.get("end_seconds")
        if speaker_label not in speaker_to_x:
            continue
        if not isinstance(start_seconds, (int, float)) or not isinstance(end_seconds, (int, float)):
            continue
        anchor_x = speaker_to_x[str(speaker_label)]
        expression = (
            f"if(between(t\\,{float(start_seconds):.3f}\\,{float(end_seconds):.3f})\\,{anchor_x}\\,{expression})"
        )

    return f"crop={crop_width}:{crop_height}:{expression}:0"


def _build_region_crop_filter(
    *,
    source_width: int | None,
    source_height: int | None,
    target_width: int,
    target_height: int,
    anchor: str | float,
) -> str | None:
    crop_width, crop_height = _resolve_crop_dimensions(
        source_width=source_width,
        source_height=source_height,
        target_width=target_width,
        target_height=target_height,
    )
    if crop_width is None or crop_height is None or not source_width or not source_height:
        return None

    if isinstance(anchor, (float, int)):
        target_center_x = float(anchor) * float(source_width)
        x_offset = max(0, int(round(target_center_x - (crop_width / 2))))
        x_offset = min(x_offset, max(0, source_width - crop_width))
    elif anchor == "left":
        x_offset = 0
    elif anchor == "right":
        x_offset = max(0, source_width - crop_width)
    else:
        x_offset = max(0, int(round((source_width - crop_width) / 2)))

    x_offset -= x_offset % 2
    y_offset = max(0, int(round((source_height - crop_height) / 2)))
    y_offset -= y_offset % 2
    return f"crop={crop_width}:{crop_height}:{x_offset}:{y_offset}"


def _resolve_split_anchor_ratios(layout_options: dict[str, Any]) -> tuple[float, float]:
    summary = layout_options.get("face_layout_summary")
    if not isinstance(summary, dict):
        return (0.28, 0.72)

    left_value = summary.get("left_anchor_ratio")
    right_value = summary.get("right_anchor_ratio")
    left_ratio = float(left_value) if isinstance(left_value, (float, int)) else 0.28
    right_ratio = float(right_value) if isinstance(right_value, (float, int)) else 0.72

    left_ratio = min(max(left_ratio, 0.16), 0.46)
    right_ratio = min(max(right_ratio, 0.54), 0.84)
    if left_ratio >= right_ratio:
        return (0.28, 0.72)
    return (round(left_ratio, 4), round(right_ratio, 4))


def _resolve_crop_dimensions(
    *,
    source_width: int | None,
    source_height: int | None,
    target_width: int,
    target_height: int,
) -> tuple[int | None, int | None]:
    if not source_width or not source_height:
        return (None, None)
    if source_width <= 0 or source_height <= 0:
        return (None, None)

    source_ratio = source_width / source_height
    target_ratio = target_width / target_height

    if abs(source_ratio - target_ratio) < 0.0001:
        return (source_width, source_height)

    if source_ratio > target_ratio:
        crop_width = max(2, int(round(source_height * target_ratio)))
        crop_width = min(crop_width, source_width)
        crop_width -= crop_width % 2
        return (crop_width, source_height)

    crop_height = max(2, int(round(source_width / target_ratio)))
    crop_height = min(crop_height, source_height)
    crop_height -= crop_height % 2
    return (source_width, crop_height)


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
