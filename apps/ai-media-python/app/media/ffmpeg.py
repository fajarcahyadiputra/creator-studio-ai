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

    normalized_strategy = str(crop_strategy or "AUTO_REFRAME").strip().upper()

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
            crop_strategy=normalized_strategy,
        )

    if _should_use_standard_split_screen(crop_strategy=normalized_strategy, layout_options=layout_options or {}):
        return _build_standard_split_screen_render_command(
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
        crop_strategy=normalized_strategy,
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


def _should_use_standard_split_screen(*, crop_strategy: str, layout_options: dict[str, Any]) -> bool:
    # A split strategy is a user preference. The analyzer must still confirm
    # multiple stable active speakers before FFmpeg creates extra panels.
    return bool(layout_options.get("split_frame_enabled"))


def _build_standard_split_screen_render_command(
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
    face_summary = layout_options.get("face_layout_summary")
    panel_count = min(
        4,
        max(
            2,
            int(face_summary.get("adaptive_panel_count") or 2)
            if isinstance(face_summary, dict)
            else 2,
        ),
    )
    single_crop = _build_face_tracking_crop_filter(
        source_width=source_width,
        source_height=source_height,
        target_width=width,
        target_height=height,
        layout_options=layout_options,
    ) or _build_safe_full_frame_fit_filter(
        source_width=source_width,
        source_height=source_height,
        target_width=width,
        target_height=height,
    )
    single_chain = ",".join(
        [part for part in ["setpts=PTS-STARTPTS", single_crop, f"scale={width}:{height}", f"fps={fps}"] if part]
    )
    graph_parts = [f"[0:v]{single_chain}[clip_single]"]
    current_label = "clip_single"
    for count in range(2, panel_count + 1):
        layout_label = _append_adaptive_split_layout(
            graph_parts=graph_parts,
            panel_count=count,
            source_width=source_width,
            source_height=source_height,
            width=width,
            height=height,
            fps=fps,
            duration_seconds=duration_seconds,
            layout_options=layout_options,
        )
        enable_expression = _build_split_enable_expression(
            layout_options=layout_options,
            duration_seconds=duration_seconds,
            minimum_face_count=count,
            maximum_face_count=count if count < panel_count else None,
        )
        next_label = f"clip_adaptive_{count}"
        graph_parts.append(
            f"[{current_label}][{layout_label}]overlay=0:0:enable='{enable_expression}'[{next_label}]"
        )
        current_label = next_label

    graph_parts.append(f"[{current_label}]null[clip]")
    headline_filters = _build_standard_headline_filter_chain(
        layout_options=layout_options,
        target_width=width,
        target_height=height,
    )
    current_label = "clip"
    if headline_filters:
        graph_parts.append(f"[clip]{','.join(headline_filters)}[clip_headline]")
        current_label = "clip_headline"
    if subtitle_path is not None:
        escaped_subtitle = _escape_filter_value(subtitle_path)
        graph_parts.append(f"[{current_label}]subtitles='{escaped_subtitle}'[vout]")
    else:
        graph_parts.append(f"[{current_label}]null[vout]")

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
        "-filter_complex",
        ";".join(graph_parts),
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
    return FfmpegCommand(executable="ffmpeg", arguments=tuple(arguments))


def _append_adaptive_split_layout(
    *,
    graph_parts: list[str],
    panel_count: int,
    source_width: int | None,
    source_height: int | None,
    width: int,
    height: int,
    fps: int,
    duration_seconds: float,
    layout_options: dict[str, Any],
) -> str:
    if panel_count == 2:
        half_height = height // 2
        panel_specs = [
            (width, half_height, 0, 0),
            (width, height - half_height, 0, half_height),
        ]
    elif panel_count == 3:
        half_width = width // 2
        half_height = height // 2
        panel_specs = [
            (half_width, half_height, 0, 0),
            (width - half_width, half_height, half_width, 0),
            (width, height - half_height, 0, half_height),
        ]
    else:
        half_width = width // 2
        half_height = height // 2
        panel_specs = [
            (half_width, half_height, 0, 0),
            (width - half_width, half_height, half_width, 0),
            (half_width, height - half_height, 0, half_height),
            (width - half_width, height - half_height, half_width, half_height),
        ]

    face_summary = layout_options.get("face_layout_summary")
    subject_anchors = face_summary.get("subject_anchor_ratios") if isinstance(face_summary, dict) else None
    if not isinstance(subject_anchors, list):
        subject_anchors = []

    panel_labels: list[str] = []
    for index in range(panel_count):
        panel_width, panel_height, _, _ = panel_specs[index]
        default_anchor = (
            float(subject_anchors[index])
            if index < len(subject_anchors) and isinstance(subject_anchors[index], (int, float))
            else (index + 1) / (panel_count + 1)
        )
        crop_filter = _build_split_panel_crop_filter(
            source_width=source_width,
            source_height=source_height,
            target_width=panel_width,
            target_height=panel_height,
            default_anchor=default_anchor,
            duration_seconds=duration_seconds,
            layout_options=layout_options,
            anchor_key=f"subject_anchor_{index}",
        )
        chain = ",".join(
            [
                part
                for part in [
                    "setpts=PTS-STARTPTS",
                    crop_filter,
                    f"scale={panel_width}:{panel_height}",
                    f"fps={fps}",
                ]
                if part
            ]
        )
        label = f"panel_{panel_count}_{index}"
        graph_parts.append(f"[0:v]{chain}[{label}]")
        panel_labels.append(label)

    canvas_label = f"canvas_{panel_count}"
    graph_parts.append(f"color=c=black:s={width}x{height}:r={fps}:d={duration_seconds:.3f}[{canvas_label}]")
    previous_label = canvas_label
    for index, (_, _, x, y) in enumerate(panel_specs[:panel_count]):
        output_label = f"layout_{panel_count}" if index == panel_count - 1 else f"layout_{panel_count}_{index}"
        graph_parts.append(f"[{previous_label}][{panel_labels[index]}]overlay={x}:{y}[{output_label}]")
        previous_label = output_label
    return previous_label


def _build_split_panel_crop_filter(
    *,
    source_width: int | None,
    source_height: int | None,
    target_width: int,
    target_height: int,
    default_anchor: float,
    duration_seconds: float,
    layout_options: dict[str, Any],
    anchor_key: str,
) -> str | None:
    crop_width, crop_height = _resolve_crop_dimensions(
        source_width=source_width,
        source_height=source_height,
        target_width=target_width,
        target_height=target_height,
    )
    if crop_width is None or crop_height is None or not source_width or not source_height:
        return None

    face_layout_summary = layout_options.get("face_layout_summary")
    if not isinstance(face_layout_summary, dict):
        return _build_region_crop_filter(
            source_width=source_width,
            source_height=source_height,
            target_width=target_width,
            target_height=target_height,
            anchor=default_anchor,
        )

    sample_anchor_pairs = face_layout_summary.get("sample_anchor_pairs")
    sample_offsets = face_layout_summary.get("sample_offsets_seconds")
    if not isinstance(sample_anchor_pairs, list) or not isinstance(sample_offsets, list):
        return _build_region_crop_filter(
            source_width=source_width,
            source_height=source_height,
            target_width=target_width,
            target_height=target_height,
            anchor=default_anchor,
        )

    normalized_samples: list[tuple[float, float, dict[str, Any] | None]] = []
    for index, sample in enumerate(sample_anchor_pairs):
        if index >= len(sample_offsets):
            break
        if not isinstance(sample, dict):
            continue
        offset_value = sample_offsets[index]
        if anchor_key.startswith("subject_anchor_"):
            anchors = sample.get("subject_anchor_ratios")
            bounds = sample.get("subject_bounds_ratios")
            try:
                anchor_index = int(anchor_key.rsplit("_", 1)[-1])
            except ValueError:
                anchor_index = -1
            anchor_value = anchors[anchor_index] if isinstance(anchors, list) and 0 <= anchor_index < len(anchors) else None
            bound_value = bounds[anchor_index] if isinstance(bounds, list) and 0 <= anchor_index < len(bounds) else None
        else:
            anchor_value = sample.get(anchor_key)
            bound_value = None
        if not isinstance(offset_value, (int, float)) or not isinstance(anchor_value, (int, float)):
            continue
        if sample.get("split_qualified") is False:
            continue
        normalized_samples.append((float(offset_value), float(anchor_value), bound_value if isinstance(bound_value, dict) else None))

    if not normalized_samples:
        return _build_region_crop_filter(
            source_width=source_width,
            source_height=source_height,
            target_width=target_width,
            target_height=target_height,
            anchor=default_anchor,
        )

    expression = str(
        _resolve_horizontal_crop_offset(
            source_width=source_width,
            crop_width=crop_width,
            anchor=default_anchor,
        )
    )
    for index in range(len(normalized_samples) - 1, -1, -1):
        offset_seconds, anchor_ratio, bound_value = normalized_samples[index]
        start_seconds = 0.0 if index == 0 else max(0.0, (normalized_samples[index - 1][0] + offset_seconds) / 2)
        end_seconds = (
            float(duration_seconds)
            if index == len(normalized_samples) - 1
            else min(float(duration_seconds), (offset_seconds + normalized_samples[index + 1][0]) / 2)
        )
        if end_seconds <= start_seconds:
            continue
        sample_bounds = {
            "face_left_ratio": bound_value.get("left") if bound_value else None,
            "face_right_ratio": bound_value.get("right") if bound_value else None,
        }
        x_offset = _resolve_sample_crop_offset(
            source_width=source_width,
            crop_width=crop_width,
            sample=sample_bounds,
            anchor_ratio=anchor_ratio,
        )
        expression = (
            f"if(between(t\\,{start_seconds:.3f}\\,{end_seconds:.3f})\\,{x_offset}\\,{expression})"
        )

    y_offset = max(0, int(round((source_height - crop_height) / 2)))
    y_offset -= y_offset % 2
    return f"crop={crop_width}:{crop_height}:{expression}:{y_offset}"


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
    # Every dynamic crop/split expression uses clip-local time. Input seeking
    # may preserve source timestamps on some containers, so normalize PTS
    # before evaluating tracking transitions.
    filters: list[str] = ["setpts=PTS-STARTPTS"]
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
    if not filters:
        filters.append(f"scale={target_width}:{target_height}")
    elif crop_filter:
        filters.append(f"scale={target_width}:{target_height}")
    filters.append(f"fps={fps}")
    filters.extend(
        _build_standard_headline_filter_chain(
            layout_options=normalized_options,
            target_width=target_width,
            target_height=target_height,
        )
    )
    if subtitle_path is not None:
        escaped_subtitle = _escape_filter_value(subtitle_path)
        filters.append(f"subtitles='{escaped_subtitle}'")
    return ",".join(filters)
def _build_standard_headline_filter_chain(
    *,
    layout_options: dict[str, Any],
    target_width: int,
    target_height: int,
) -> list[str]:
    if not layout_options.get("standard_headline_enabled") or target_height <= target_width:
        return []
    raw_files = layout_options.get("standard_headline_files")
    if not isinstance(raw_files, list):
        return []
    headline_files = [value for value in raw_files if isinstance(value, (str, Path)) and str(value).strip()][:3]
    if not headline_files:
        return []

    position = str(layout_options.get("standard_headline_position") or "BOTTOM").strip().upper()
    scale = target_width / 1080
    left = max(42, int(round(target_width * 0.09)))
    font_size = max(34, int(round(58 * scale)))
    line_height = max(54, int(round(74 * scale)))
    base_y = int(round(target_height * (0.14 if position == "TOP" else 0.58)))
    quote_width = max(54, int(round(78 * scale)))
    quote_height = max(38, int(round(50 * scale)))
    quote_y = max(24, base_y - quote_height - max(16, int(round(18 * scale))))
    duration_value = layout_options.get("standard_headline_duration_seconds")
    duration_seconds = (
        min(5.0, max(1.5, float(duration_value)))
        if isinstance(duration_value, (int, float))
        else 3.5
    )
    enable = f"enable='between(t\\,0\\,{duration_seconds:.3f})'"
    mark_width = max(9, int(round(14 * scale)))
    mark_height = max(11, int(round(18 * scale)))
    stem_width = max(5, int(round(8 * scale)))
    stem_height = max(7, int(round(10 * scale)))
    first_mark_x = left + max(10, int(round(14 * scale)))
    second_mark_x = first_mark_x + mark_width + max(8, int(round(10 * scale)))
    mark_y = quote_y + max(7, int(round(9 * scale)))
    stem_y = mark_y + mark_height - max(2, int(round(3 * scale)))
    filters = [
        f"drawbox=x={left}:y={quote_y}:w={quote_width}:h={quote_height}:color=0x61d6c5@0.96:t=fill:{enable}",
        f"drawbox=x={first_mark_x}:y={mark_y}:w={mark_width}:h={mark_height}:color=white@0.98:t=fill:{enable}",
        f"drawbox=x={first_mark_x}:y={stem_y}:w={stem_width}:h={stem_height}:color=white@0.98:t=fill:{enable}",
        f"drawbox=x={second_mark_x}:y={mark_y}:w={mark_width}:h={mark_height}:color=white@0.98:t=fill:{enable}",
        f"drawbox=x={second_mark_x}:y={stem_y}:w={stem_width}:h={stem_height}:color=white@0.98:t=fill:{enable}",
    ]
    for index, text_file in enumerate(headline_files):
        escaped_path = _escape_filter_value(text_file)
        filters.append(
            f"drawtext=textfile='{escaped_path}':fontcolor=0x111827:fontsize={font_size}:"
            f"x={left}:y={base_y + (index * line_height)}:box=1:boxcolor=white@0.97:"
            f"boxborderw={max(8, int(round(12 * scale)))}:{enable}"
        )
    return filters


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
    split_frame_enabled = bool(layout_options.get("split_frame_enabled"))
    graph_parts: list[str] = []

    if split_frame_enabled:
        top_height = panel_height // 2
        bottom_height = panel_height - top_height
        left_anchor_ratio, right_anchor_ratio = _resolve_split_anchor_ratios(layout_options)
        top_crop = _build_region_crop_filter(
            source_width=source_width,
            source_height=source_height,
            target_width=panel_width,
            target_height=top_height,
            anchor=left_anchor_ratio,
        )
        bottom_crop = _build_region_crop_filter(
            source_width=source_width,
            source_height=source_height,
            target_width=panel_width,
            target_height=bottom_height,
            anchor=right_anchor_ratio,
        )
        top_chain = ",".join(
            [
                part
                for part in ["setpts=PTS-STARTPTS", top_crop, f"scale={panel_width}:{top_height}", f"fps={fps}"]
                if part
            ]
        )
        bottom_chain = ",".join(
            [
                part
                for part in [
                    "setpts=PTS-STARTPTS",
                    bottom_crop,
                    f"scale={panel_width}:{bottom_height}",
                    f"fps={fps}",
                ]
                if part
            ]
        )
        single_crop = _build_face_tracking_crop_filter(
            source_width=source_width,
            source_height=source_height,
            target_width=panel_width,
            target_height=panel_height,
            layout_options=layout_options,
        ) or _build_center_crop_filter(
            source_width=source_width,
            source_height=source_height,
            target_width=panel_width,
            target_height=panel_height,
        )
        single_chain = ",".join(
            [
                part
                for part in [
                    "setpts=PTS-STARTPTS",
                    single_crop,
                    f"scale={panel_width}:{panel_height}",
                    f"fps={fps}",
                ]
                if part
            ]
        )
        split_enable_expression = _build_split_enable_expression(
            layout_options=layout_options,
            duration_seconds=float(layout_options.get("clip_duration_seconds") or 0),
        )
        graph_parts.extend(
            [
                f"[0:v]{single_chain}[clip_single]",
                f"[0:v]{top_chain}[clip_top]",
                f"[0:v]{bottom_chain}[clip_bottom]",
                "[clip_top][clip_bottom]vstack=inputs=2[clip_split]",
                f"[clip_single][clip_split]overlay=0:0:enable='{split_enable_expression}'[clip]",
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
        video_filters = [
            part
            for part in [
                "setpts=PTS-STARTPTS",
                crop_filter,
                f"scale={panel_width}:{panel_height}",
                f"fps={fps}",
            ]
            if part
        ]
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


def _build_safe_full_frame_fit_filter(
    *,
    source_width: int | None,
    source_height: int | None,
    target_width: int,
    target_height: int,
) -> str | None:
    if not source_width or not source_height or source_width <= 0 or source_height <= 0:
        return None
    return (
        f"scale={target_width}:{target_height}:force_original_aspect_ratio=decrease,"
        f"pad={target_width}:{target_height}:(ow-iw)/2:(oh-ih)/2:color=black"
    )


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

    if normalized_strategy in {"ACTIVE_SPEAKER", "SMART_SPEAKER"} or (
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
    crop_strategy = str(layout_options.get("crop_strategy") or "").strip().upper()
    active_tracking_samples = face_layout_summary.get("active_face_tracking_samples")
    has_active_tracking_anchor = bool(
        isinstance(active_tracking_samples, list)
        and any(
            isinstance(sample, dict) and isinstance(sample.get("anchor_ratio"), (int, float))
            for sample in active_tracking_samples
        )
    )
    if (
        "valid_face_sample_count" in face_layout_summary
        and int(face_layout_summary.get("valid_face_sample_count") or 0) == 0
        and not has_active_tracking_anchor
    ):
        # Smart-speaker output must always fill the portrait canvas. When
        # visual tracking is inconclusive, a centered cover crop is safer
        # than shrinking a landscape frame into black letterbox bars.
        if crop_strategy in {"ACTIVE_SPEAKER", "SMART_SPEAKER"}:
            return _build_center_crop_filter(
                source_width=source_width,
                source_height=source_height,
                target_width=target_width,
                target_height=target_height,
            )
        return _build_safe_full_frame_fit_filter(
            source_width=source_width,
            source_height=source_height,
            target_width=target_width,
            target_height=target_height,
        )
    tracking_samples = (
        active_tracking_samples
        if crop_strategy in {"ACTIVE_SPEAKER", "SMART_SPEAKER"} and isinstance(active_tracking_samples, list)
        else face_layout_summary.get("tracking_samples")
    )
    sample_offsets = face_layout_summary.get("sample_offsets_seconds")
    duration_seconds = layout_options.get("clip_duration_seconds")
    if (
        isinstance(tracking_samples, list)
        and isinstance(sample_offsets, list)
        and isinstance(duration_seconds, (float, int))
    ):
        temporal_filter = _build_temporal_tracking_crop_filter(
            source_width=source_width,
            source_height=source_height,
            target_width=target_width,
            target_height=target_height,
            tracking_samples=tracking_samples,
            sample_offsets=sample_offsets,
            duration_seconds=float(duration_seconds),
        )
        if temporal_filter:
            return temporal_filter

    anchor_ratio = face_layout_summary.get("single_face_anchor_ratio")
    if isinstance(anchor_ratio, (float, int)):
        return _build_region_crop_filter(
            source_width=source_width,
            source_height=source_height,
            target_width=target_width,
            target_height=target_height,
            anchor=float(anchor_ratio),
        )
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


def _build_temporal_tracking_crop_filter(
    *,
    source_width: int | None,
    source_height: int | None,
    target_width: int,
    target_height: int,
    tracking_samples: list[Any],
    sample_offsets: list[Any],
    duration_seconds: float,
) -> str | None:
    crop_width, crop_height = _resolve_crop_dimensions(
        source_width=source_width,
        source_height=source_height,
        target_width=target_width,
        target_height=target_height,
    )
    if not source_width or not source_height or crop_width is None or crop_height is None:
        return None

    normalized: list[tuple[float, float, dict[str, Any]]] = []
    for index, sample in enumerate(tracking_samples):
        if index >= len(sample_offsets) or not isinstance(sample, dict):
            break
        offset = sample_offsets[index]
        anchor = sample.get("anchor_ratio")
        if isinstance(offset, (float, int)) and isinstance(anchor, (float, int)):
            normalized.append(
                (
                    float(offset),
                    min(1.0, max(0.0, float(anchor))),
                    sample,
                )
            )
    if not normalized:
        return None

    tracking_states: list[tuple[float, int]] = []
    for index, (offset_seconds, anchor_ratio, sample) in enumerate(normalized):
        boundary_seconds = (
            0.0
            if index == 0
            else max(0.0, ((normalized[index - 1][0] + offset_seconds) / 2) - 0.18)
        )
        x_offset = _resolve_sample_crop_offset(
            source_width=source_width,
            crop_width=crop_width,
            sample=sample,
            anchor_ratio=anchor_ratio,
        )
        if tracking_states and abs(tracking_states[-1][1] - x_offset) < 12:
            continue
        tracking_states.append((boundary_seconds, x_offset))

    expression = _build_smooth_tracking_x_expression(tracking_states)

    y_offset = max(0, int(round((source_height - crop_height) / 2)))
    y_offset -= y_offset % 2
    return f"crop={crop_width}:{crop_height}:{expression}:{y_offset}"


def _resolve_sample_crop_offset(
    *,
    source_width: int,
    crop_width: int,
    sample: dict[str, Any],
    anchor_ratio: float,
) -> int:
    default_offset = _resolve_horizontal_crop_offset(
        source_width=source_width,
        crop_width=crop_width,
        anchor=anchor_ratio,
    )
    left_ratio = sample.get("face_left_ratio")
    right_ratio = sample.get("face_right_ratio")
    if not isinstance(left_ratio, (int, float)) or not isinstance(right_ratio, (int, float)):
        return default_offset
    if float(right_ratio) <= float(left_ratio):
        return default_offset

    face_left = float(left_ratio) * source_width
    face_right = float(right_ratio) * source_width
    face_width = face_right - face_left
    margin = max(18.0, min(crop_width * 0.16, face_width * 0.65))
    minimum_offset = max(0.0, face_right + margin - crop_width)
    maximum_offset = min(float(source_width - crop_width), face_left - margin)
    if minimum_offset <= maximum_offset:
        resolved = min(max(float(default_offset), minimum_offset), maximum_offset)
    else:
        # The face is too wide or already clipped by the source. Keep as much
        # of the detected face as the source frame physically allows.
        resolved = min(
            max((face_left + face_right - crop_width) / 2, 0.0),
            float(source_width - crop_width),
        )
    even_offset = max(0, int(round(resolved)))
    return even_offset - (even_offset % 2)


def _build_smooth_tracking_x_expression(states: list[tuple[float, int]]) -> str:
    if not states:
        return "0"
    transitions = [
        (states[index][0], states[index - 1][1], states[index][1])
        for index in range(1, len(states))
    ]
    return _build_cumulative_x_expression(
        initial_x=states[0][1],
        transitions=transitions,
        transition_seconds=0.16,
    )


def _build_split_enable_expression(
    *,
    layout_options: dict[str, Any],
    duration_seconds: float,
    minimum_face_count: int = 2,
    maximum_face_count: int | None = None,
) -> str:
    face_layout_summary = layout_options.get("face_layout_summary")
    if not isinstance(face_layout_summary, dict):
        return "0"
    samples = face_layout_summary.get("sample_anchor_pairs")
    offsets = face_layout_summary.get("sample_offsets_seconds")
    if not isinstance(samples, list) or not isinstance(offsets, list) or duration_seconds <= 0:
        return "0"

    confirmed_indexes: set[int] = set()
    for index, sample in enumerate(samples):
        if index >= len(offsets) or not isinstance(sample, dict):
            break
        offset = offsets[index]
        active_speaker_count = sample.get("active_speaker_count")
        if not isinstance(offset, (float, int)):
            continue
        anchors = sample.get("subject_anchor_ratios")
        has_required_faces = (
            isinstance(active_speaker_count, int)
            and active_speaker_count >= minimum_face_count
            and (maximum_face_count is None or active_speaker_count <= maximum_face_count)
            and isinstance(anchors, list)
            and len(anchors) >= minimum_face_count
            and sample.get("split_qualified") is not False
        )
        if has_required_faces:
            confirmed_indexes.add(index)

    if not confirmed_indexes:
        return "0"

    windows: list[tuple[float, float]] = []
    for index in sorted(confirmed_indexes):
        offset = offsets[index] if index < len(offsets) else None
        if not isinstance(offset, (float, int)):
            continue
        previous_offset = float(offsets[index - 1]) if index > 0 and isinstance(offsets[index - 1], (float, int)) else 0.0
        next_offset = (
            float(offsets[index + 1])
            if index + 1 < len(offsets) and isinstance(offsets[index + 1], (float, int))
            else duration_seconds
        )
        start = 0.0 if index == 0 else max(0.0, (previous_offset + float(offset)) / 2)
        end = duration_seconds if index == len(samples) - 1 else min(duration_seconds, (float(offset) + next_offset) / 2)
        if end > start:
            windows.append((start, end))

    merged_windows: list[tuple[float, float]] = []
    for start, end in windows:
        if merged_windows and start <= merged_windows[-1][1] + 0.05:
            merged_windows[-1] = (merged_windows[-1][0], max(merged_windows[-1][1], end))
        else:
            merged_windows.append((start, end))
    return "+".join(f"between(t\\,{start:.3f}\\,{end:.3f})" for start, end in merged_windows)


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

    speaker_order = active_strategy.get("speaker_order")
    windows = active_strategy.get("windows")
    if (
        active_strategy.get("available") is not True
        or not isinstance(speaker_order, list)
        or len(speaker_order) < 2
        or not isinstance(windows, list)
    ):
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

    left_anchor_ratio, right_anchor_ratio = _resolve_split_anchor_ratios(layout_options)
    left_x = _resolve_horizontal_crop_offset(
        source_width=source_width,
        crop_width=crop_width,
        anchor=left_anchor_ratio,
    )
    center_x = max(0, ((source_width - crop_width) // 2) // 2 * 2)
    right_x = _resolve_horizontal_crop_offset(
        source_width=source_width,
        crop_width=crop_width,
        anchor=right_anchor_ratio,
    )
    speaker_to_x = {
        str(speaker_order[0]): left_x,
        str(speaker_order[1]): right_x,
    }
    speaker_anchor_ratios = active_strategy.get("speaker_anchor_ratios")
    default_speaker_anchors = {
        str(speaker_order[0]): left_anchor_ratio,
        str(speaker_order[1]): right_anchor_ratio,
    }
    if isinstance(speaker_anchor_ratios, dict):
        for label, anchor in speaker_anchor_ratios.items():
            normalized_label = str(label)
            if normalized_label not in default_speaker_anchors or not isinstance(anchor, (int, float)):
                continue
            speaker_to_x[normalized_label] = _resolve_horizontal_crop_offset(
                source_width=source_width,
                crop_width=crop_width,
                anchor=min(1.0, max(0.0, float(anchor))),
            )

    normalized_windows: list[tuple[str, float, float]] = []
    for window in windows:
        speaker_label = window.get("speaker_label")
        start_seconds = window.get("start_seconds")
        end_seconds = window.get("end_seconds")
        if speaker_label not in speaker_to_x:
            continue
        if not isinstance(start_seconds, (int, float)) or not isinstance(end_seconds, (int, float)):
            continue
        if float(end_seconds) <= float(start_seconds):
            continue
        normalized_windows.append((str(speaker_label), float(start_seconds), float(end_seconds)))

    expression = (
        _build_smooth_speaker_x_expression(
            windows=normalized_windows,
            speaker_to_x=speaker_to_x,
            transition_seconds=float(active_strategy.get("transition_seconds") or 0.16),
        )
        if normalized_windows
        else str(center_x)
    )

    y_offset = max(0, int(round((source_height - crop_height) / 2)))
    y_offset -= y_offset % 2
    return f"crop={crop_width}:{crop_height}:{expression}:{y_offset}"


def _build_smooth_speaker_x_expression(
    *,
    windows: list[tuple[str, float, float]],
    speaker_to_x: dict[str, int],
    transition_seconds: float,
) -> str:
    initial_label = windows[0][0]
    previous_label = initial_label
    transitions: list[tuple[float, int, int]] = []
    for label, start_seconds, _end_seconds in windows[1:]:
        if label == previous_label:
            continue
        transitions.append((start_seconds, speaker_to_x[previous_label], speaker_to_x[label]))
        previous_label = label

    duration = min(0.24, max(0.08, transition_seconds))
    return _build_cumulative_x_expression(
        initial_x=speaker_to_x[initial_label],
        transitions=transitions,
        transition_seconds=duration,
    )


def _build_cumulative_x_expression(
    *,
    initial_x: int,
    transitions: list[tuple[float, int, int]],
    transition_seconds: float,
) -> str:
    """Build a flat crop expression whose parser depth is constant.

    Nested ``if`` expressions grow one level per speaker change and eventually
    exceed FFmpeg's expression parser for long clips. Summed deltas produce the
    same piecewise movement while keeping every transition independent.
    """
    duration = max(0.001, float(transition_seconds))
    transitions = _compress_x_transitions(
        initial_x=initial_x,
        transitions=transitions,
        maximum_transitions=80,
    )
    terms = [str(int(initial_x))]
    seen: set[tuple[int, int, int]] = set()
    for start_seconds, from_x, to_x in transitions:
        delta = int(to_x) - int(from_x)
        if delta == 0:
            continue
        timestamp_ms = max(0, int(round(float(start_seconds) * 1000)))
        transition_key = (timestamp_ms, int(from_x), int(to_x))
        if transition_key in seen:
            continue
        seen.add(transition_key)
        start = timestamp_ms / 1000
        progress = f"clip((t-{start:.3f})/{duration:.3f}\\,0\\,1)"
        terms.append(f"({delta})*{progress}")
    return "+".join(terms)


def _compress_x_transitions(
    *,
    initial_x: int,
    transitions: list[tuple[float, int, int]],
    maximum_transitions: int,
) -> list[tuple[float, int, int]]:
    """Bound FFmpeg expression size while preserving the full clip timeline."""
    if maximum_transitions <= 0 or not transitions:
        return []

    normalized = sorted(transitions, key=lambda transition: float(transition[0]))
    if len(normalized) > maximum_transitions:
        last_index = len(normalized) - 1
        selected_indexes = {
            round(position * last_index / (maximum_transitions - 1))
            for position in range(maximum_transitions)
        }
        normalized = [normalized[index] for index in sorted(selected_indexes)]

    compressed: list[tuple[float, int, int]] = []
    current_x = int(initial_x)
    for start_seconds, _from_x, target_x in normalized:
        resolved_target = int(target_x)
        if resolved_target == current_x:
            continue
        compressed.append((float(start_seconds), current_x, resolved_target))
        current_x = resolved_target
    return compressed


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

    x_offset = _resolve_horizontal_crop_offset(
        source_width=source_width,
        crop_width=crop_width,
        anchor=anchor,
    )
    y_offset = max(0, int(round((source_height - crop_height) / 2)))
    y_offset -= y_offset % 2
    return f"crop={crop_width}:{crop_height}:{x_offset}:{y_offset}"


def _resolve_horizontal_crop_offset(
    *,
    source_width: int,
    crop_width: int,
    anchor: str | float,
) -> int:
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
    return x_offset


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
