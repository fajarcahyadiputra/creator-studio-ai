from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from pathlib import Path
from time import monotonic
from typing import Any

import httpx
from temporalio import activity
from temporalio.exceptions import ApplicationError

from app.config import get_settings
from app.activities.warning_events import emit_retry_warning
from app.domain.contracts import ClipOutputResult, ClipRenderArtifactUpload, ClipRenderContext, TranscriptSegment
from app.infrastructure.clip_output_client import ClipOutputClient
from app.media.ffmpeg import build_clip_render_command
from app.activities.media_validation import run_ffprobe_json

SUPPORTED_SUBTITLE_FORMATS = {"srt", "ass", "vtt", "json"}


@dataclass(frozen=True, slots=True)
class SubtitleCue:
    start_seconds: float
    end_seconds: float
    text: str


@activity.defn
async def prepare_clip_output_render(payload: dict[str, Any]) -> dict[str, Any]:
    clip_output_id = payload.get("clip_output_id")
    if not isinstance(clip_output_id, str) or not clip_output_id:
        raise ApplicationError("clip_output_id is required", non_retryable=True, type="InvalidInput")

    context = await ClipOutputClient().fetch_render_context(clip_output_id)
    activity.heartbeat(
        {
            "clip_output_id": context.clip_output_id,
            "job_id": context.job_id,
            "candidate_id": context.candidate_id,
            "source_media_id": context.source_media.media_asset_id,
        }
    )
    return context.model_dump(mode="json")


@activity.defn
async def execute_clip_output_render(payload: dict[str, Any]) -> dict[str, Any]:
    context = ClipRenderContext.model_validate(payload)
    settings = get_settings()

    aspect_ratio = _resolve_aspect_ratio(context.render_settings)
    layout_template = _resolve_layout_template(context.render_settings, aspect_ratio)
    subtitle_format = _resolve_subtitle_format(context.render_settings)
    subtitle_language = _resolve_subtitle_language(context.render_settings)
    subtitle_burned_in = _resolve_subtitle_burned_in(context.render_settings)
    width, height = _resolve_dimensions(aspect_ratio)
    fps = 30
    clip_start_seconds = int(context.candidate.start_ms) / 1000
    clip_duration_seconds = max(int(context.candidate.duration_ms) / 1000, 0.001)
    candidate_metadata = _resolve_render_metadata(context.render_settings)

    working_directory = Path(settings.TEMP_WORKDIR) / "clip-output-renders" / context.clip_output_id
    working_directory.mkdir(parents=True, exist_ok=True)
    final_path = working_directory / "final.mp4"
    metadata_path = working_directory / "metadata.json"
    subtitle_srt_path = working_directory / "subtitle.srt"
    subtitle_ass_path = working_directory / "subtitle.ass"
    subtitle_vtt_path = working_directory / "subtitle.vtt"
    subtitle_json_path = working_directory / "subtitle.json"
    channel_name_path = working_directory / "channel-name.txt"
    channel_tagline_path = working_directory / "channel-tagline.txt"
    headline_path = working_directory / "headline.txt"
    quote_path = working_directory / "quote.txt"
    source_label_path = working_directory / "source-label.txt"

    subtitle_cues = _build_subtitle_cues(
        transcript_segments=context.transcript.segments if context.transcript else [],
        clip_start_seconds=clip_start_seconds,
        clip_duration_seconds=clip_duration_seconds,
    )
    subtitle_path_for_upload: Path | None = None
    subtitle_path_for_burn_in: Path | None = None
    if subtitle_cues:
        subtitle_srt_path.write_text(_render_srt(subtitle_cues), encoding="utf-8")
        subtitle_ass_path.write_text(_render_ass(subtitle_cues), encoding="utf-8")
        subtitle_vtt_path.write_text(_render_vtt(subtitle_cues), encoding="utf-8")
        subtitle_json_path.write_text(_render_subtitle_json(subtitle_cues), encoding="utf-8")
        subtitle_path_for_upload = _resolve_subtitle_output_path(
            subtitle_format,
            srt_path=subtitle_srt_path,
            ass_path=subtitle_ass_path,
            vtt_path=subtitle_vtt_path,
            json_path=subtitle_json_path,
        )
        if subtitle_burned_in:
            subtitle_path_for_burn_in = subtitle_ass_path

    layout_options = _build_layout_options(
        layout_template=layout_template,
        render_settings=context.render_settings,
        candidate=context.candidate,
        metadata=candidate_metadata,
        working_directory=working_directory,
        channel_name_path=channel_name_path,
        channel_tagline_path=channel_tagline_path,
        headline_path=headline_path,
        quote_path=quote_path,
        source_label_path=source_label_path,
    )
    logo_fetch_warning: str | None = None
    try:
        logo_fetch_warning = await _materialize_optional_logo(
            layout_options=layout_options,
            working_directory=working_directory,
        )
    except Exception:
        # Branding assets are non-critical. Rendering should continue even if
        # a decorative logo cannot be fetched.
        logo_fetch_warning = "Channel logo could not be prepared for render. Continuing without logo."
        layout_options.pop("logo_source", None)

    render_command = build_clip_render_command(
        source=str(context.source_media.download_url),
        destination=final_path,
        start_seconds=clip_start_seconds,
        duration_seconds=clip_duration_seconds,
        source_width=context.source_media.width,
        source_height=context.source_media.height,
        width=width,
        height=height,
        fps=fps,
        video_preset="medium",
        subtitle_path=subtitle_path_for_burn_in,
        layout_template=layout_template,
        layout_options=layout_options,
    )
    try:
        await _run_command_with_heartbeat(
            render_command.as_exec_args(),
            timeout_seconds=settings.RENDER_OUTPUT_TIMEOUT_SECONDS,
            heartbeat_details={
                "clip_output_id": context.clip_output_id,
                "job_id": context.job_id,
                "candidate_id": context.candidate.candidate_id,
                "stage": "RENDERING_FINAL_CLIPS",
                "artifact": "final",
            },
        )
    except Exception as error:
        await emit_retry_warning(
            job_id=context.job_id,
            stage="RENDERING_FINAL_CLIPS",
            stage_progress=15,
            error=error,
            user_message="Render video final gagal di worker dan akan dicoba ulang otomatis.",
            status=None,
            metadata={
                "clip_output_id": context.clip_output_id,
                "candidate_id": context.candidate.candidate_id,
                "artifact": "final",
                "aspect_ratio": aspect_ratio,
            },
        )
        raise
    if not final_path.exists():
        missing_final_error = RuntimeError("ffmpeg completed without creating the final render output")
        await emit_retry_warning(
            job_id=context.job_id,
            stage="RENDERING_FINAL_CLIPS",
            stage_progress=20,
            error=missing_final_error,
            user_message="Render video final tidak menghasilkan file output dan akan dicoba ulang otomatis.",
            status=None,
            metadata={
                "clip_output_id": context.clip_output_id,
                "candidate_id": context.candidate.candidate_id,
                "artifact": "final",
            },
        )
        raise missing_final_error

    try:
        final_probe_payload = await run_ffprobe_json(
            str(final_path),
            timeout_seconds=settings.MEDIA_PROBE_TIMEOUT_SECONDS,
        )
    except Exception as error:
        await emit_retry_warning(
            job_id=context.job_id,
            stage="QUALITY_CHECK",
            stage_progress=80,
            error=error,
            user_message="Validasi output render gagal dibaca dan akan dicoba ulang otomatis.",
            status=None,
            metadata={
                "clip_output_id": context.clip_output_id,
                "candidate_id": context.candidate.candidate_id,
            },
        )
        raise
    final_probe_summary = _summarize_render_probe(final_probe_payload)
    validation = _build_validation_summary(
        aspect_ratio=aspect_ratio,
        width=width,
        height=height,
        expected_duration_ms=int(round(clip_duration_seconds * 1000)),
        subtitle_format=subtitle_format if subtitle_path_for_upload else None,
        final_observed=final_probe_summary,
        thumbnail_generated=False,
        subtitle_generated=bool(subtitle_path_for_upload and subtitle_path_for_upload.exists()),
        subtitle_cue_count=len(subtitle_cues),
        preview_generated=False,
    )
    if logo_fetch_warning:
        validation["warnings"].append(logo_fetch_warning)

    artifact_uploads = {upload.artifact: upload for upload in context.artifact_uploads}
    uploaded_artifacts: list[dict[str, Any]] = []
    try:
        final_object_key = await _upload_artifact(artifact_uploads.get("final"), final_path, uploaded_artifacts)
        subtitle_object_key = await _upload_artifact(
            artifact_uploads.get("subtitle"),
            subtitle_path_for_upload,
            uploaded_artifacts,
        )
        await _upload_artifact(
            artifact_uploads.get("subtitle_srt"),
            subtitle_srt_path if subtitle_srt_path.exists() else None,
            uploaded_artifacts,
        )
        await _upload_artifact(
            artifact_uploads.get("subtitle_ass"),
            subtitle_ass_path if subtitle_ass_path.exists() else None,
            uploaded_artifacts,
        )
        await _upload_artifact(
            artifact_uploads.get("subtitle_vtt"),
            subtitle_vtt_path if subtitle_vtt_path.exists() else None,
            uploaded_artifacts,
        )
        await _upload_artifact(
            artifact_uploads.get("subtitle_json"),
            subtitle_json_path if subtitle_json_path.exists() else None,
            uploaded_artifacts,
        )
    except Exception as error:
        await emit_retry_warning(
            job_id=context.job_id,
            stage="UPLOADING_OUTPUTS",
            stage_progress=90,
            error=error,
            user_message="Upload artifact render gagal dan akan dicoba ulang otomatis.",
            status=None,
            metadata={
                "clip_output_id": context.clip_output_id,
                "candidate_id": context.candidate.candidate_id,
                "uploaded_artifact_count": len(uploaded_artifacts),
            },
        )
        raise

    metadata_document = {
        "manifest_version": "phase2-render-manifest-v2",
        "renderer": "ffmpeg-worker-v1",
        "clip_output_id": context.clip_output_id,
        "job_id": context.job_id,
        "candidate": {
            "candidate_id": context.candidate.candidate_id,
            "title": context.candidate.title,
            "summary": context.candidate.summary,
            "hook_text": context.candidate.hook_text,
            "start_ms": context.candidate.start_ms,
            "end_ms": context.candidate.end_ms,
            "duration_ms": context.candidate.duration_ms,
        },
        "source_media": {
            "media_asset_id": context.source_media.media_asset_id,
            "object_key": context.source_media.object_key,
            "duration_ms": context.source_media.duration_ms,
        },
        "render_settings": context.render_settings,
        "render_plan": {
            "command": render_command.as_exec_args(),
            "width": width,
            "height": height,
            "fps": fps,
            "subtitle_burned_in": subtitle_burned_in,
            "crop_mode": "center_crop",
            "layout_template": layout_template,
        },
        "subtitle": {
            "format": subtitle_format if subtitle_path_for_upload else None,
            "language": subtitle_language if subtitle_path_for_upload else None,
            "burned_in": subtitle_burned_in,
            "cue_count": len(subtitle_cues),
            "sidecars": {
                "srt": subtitle_srt_path.name if subtitle_srt_path.exists() else None,
                "ass": subtitle_ass_path.name if subtitle_ass_path.exists() else None,
                "vtt": subtitle_vtt_path.name if subtitle_vtt_path.exists() else None,
                "json": subtitle_json_path.name if subtitle_json_path.exists() else None,
            },
        },
        "validation": validation,
        "artifacts": uploaded_artifacts,
        "metadata": candidate_metadata,
        "branding": layout_options.get("branding"),
    }
    metadata_path.write_text(json.dumps(metadata_document, indent=2), encoding="utf-8")
    try:
        metadata_object_key = await _upload_artifact(artifact_uploads.get("metadata"), metadata_path, uploaded_artifacts)
    except Exception as error:
        await emit_retry_warning(
            job_id=context.job_id,
            stage="UPLOADING_OUTPUTS",
            stage_progress=95,
            error=error,
            user_message="Upload metadata render gagal dan akan dicoba ulang otomatis.",
            status=None,
            metadata={
                "clip_output_id": context.clip_output_id,
                "candidate_id": context.candidate.candidate_id,
                "artifact": "metadata",
            },
        )
        raise

    quality_status = _resolve_quality_status(validation["status"])
    result = ClipOutputResult(
        quality_status=quality_status,
        preview_object_key=None,
        final_object_key=final_object_key,
        metadata_object_key=metadata_object_key,
        subtitle_object_key=subtitle_object_key,
        subtitle_format=subtitle_format if subtitle_path_for_upload else None,
        subtitle_language=subtitle_language if subtitle_path_for_upload else None,
        subtitle_burned_in=subtitle_burned_in if subtitle_path_for_upload else None,
        quality_report={
            **metadata_document,
            "artifacts": uploaded_artifacts,
            "status": "completed",
        },
        duration_ms=str(final_probe_summary["duration_ms"]) if final_probe_summary["duration_ms"] is not None else None,
        width=final_probe_summary["width"] or width,
        height=final_probe_summary["height"] or height,
    )
    activity.heartbeat(
        {
            "clip_output_id": context.clip_output_id,
            "quality_status": result.quality_status,
            "width": result.width,
            "height": result.height,
        }
    )
    return result.model_dump(mode="json", exclude_none=True)


async def _materialize_optional_logo(
    *,
    layout_options: dict[str, Any],
    working_directory: Path,
) -> str | None:
    logo_source = layout_options.get("logo_source")
    if not isinstance(logo_source, str) or not logo_source.strip():
        return None

    normalized_source = logo_source.strip()
    if normalized_source.startswith(("http://", "https://")):
        local_path = working_directory / "branding-logo"
        downloaded = await _download_optional_asset(normalized_source, local_path)
        if downloaded is None:
            layout_options.pop("logo_source", None)
            return "Channel logo URL was unavailable during render, so the final clip was rendered without logo."
        layout_options["logo_source"] = str(downloaded)
    return None


async def _download_optional_asset(url: str, destination_stem: Path) -> Path | None:
    try:
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            response = await client.get(url)
            response.raise_for_status()
    except Exception:
        return None

    suffix = _resolve_asset_suffix_from_url(url)
    destination = destination_stem.with_suffix(suffix)
    destination.write_bytes(response.content)
    return destination


def _resolve_asset_suffix_from_url(url: str) -> str:
    try:
        parsed = httpx.URL(url)
        suffix = Path(parsed.path).suffix.lower()
    except Exception:
        suffix = ""

    if suffix in {".png", ".jpg", ".jpeg", ".webp", ".svg"}:
        return suffix
    return ".img"


@activity.defn
async def submit_clip_output_result(payload: dict[str, Any]) -> None:
    clip_output_id = payload.get("clip_output_id")
    result = payload.get("result")
    if not isinstance(clip_output_id, str) or not isinstance(result, dict):
        raise ApplicationError("clip output result payload is required", non_retryable=True, type="InvalidInput")
    parsed = ClipOutputResult.model_validate(result)
    await ClipOutputClient().submit_result(clip_output_id, parsed)


def _resolve_aspect_ratio(render_settings: dict[str, Any]) -> str:
    visual = render_settings.get("visual")
    if isinstance(visual, dict):
        value = visual.get("aspect_ratio")
        if isinstance(value, str) and value:
            return value
    return "9:16"


def _resolve_layout_template(render_settings: dict[str, Any], aspect_ratio: str) -> str | None:
    if aspect_ratio != "9:16":
        return None
    visual = render_settings.get("visual")
    if isinstance(visual, dict):
        settings = visual.get("settings")
        if isinstance(settings, dict):
            value = settings.get("layout_template")
            if isinstance(value, str) and value == "PODCAST_SPOTLIGHT_9X16":
                return value
    return None


def _resolve_subtitle_burned_in(render_settings: dict[str, Any]) -> bool:
    subtitle = render_settings.get("subtitle")
    if isinstance(subtitle, dict):
        for key in ("burned_in", "burn_in"):
            value = subtitle.get(key)
            if isinstance(value, bool):
                return value
    return False


def _resolve_dimensions(aspect_ratio: str) -> tuple[int, int]:
    if aspect_ratio == "1:1":
        return (1080, 1080)
    if aspect_ratio == "4:5":
        return (1080, 1350)
    if aspect_ratio == "16:9":
        return (1920, 1080)
    return (1080, 1920)


def _resolve_target(existing: Any, fallback: str) -> str:
    return existing if isinstance(existing, str) and existing else fallback


def _resolve_subtitle_format(render_settings: dict[str, Any]) -> str:
    subtitle = render_settings.get("subtitle")
    if isinstance(subtitle, dict):
        value = subtitle.get("format")
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized in SUPPORTED_SUBTITLE_FORMATS:
                return normalized
    return "srt"


def _resolve_subtitle_output_path(
    subtitle_format: str,
    *,
    srt_path: Path,
    ass_path: Path,
    vtt_path: Path,
    json_path: Path,
) -> Path:
    if subtitle_format == "ass":
        return ass_path
    if subtitle_format == "vtt":
        return vtt_path
    if subtitle_format == "json":
        return json_path
    return srt_path


def _resolve_subtitle_language(render_settings: dict[str, Any]) -> str:
    subtitle = render_settings.get("subtitle")
    if isinstance(subtitle, dict):
        value = subtitle.get("language")
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized:
                return normalized
    return "id"


def _resolve_render_metadata(render_settings: dict[str, Any]) -> dict[str, Any]:
    metadata = render_settings.get("metadata")
    if not isinstance(metadata, dict):
        return {}

    hashtags = metadata.get("suggested_hashtags")
    normalized_hashtags = (
        [value for value in hashtags if isinstance(value, str) and value.strip()]
        if isinstance(hashtags, list)
        else []
    )

    return {
        "suggested_caption": _resolve_string(metadata.get("suggested_caption")),
        "suggested_cta": _resolve_string(metadata.get("suggested_cta")),
        "suggested_hashtags": normalized_hashtags,
        "thumbnail_text": _resolve_string(metadata.get("thumbnail_text")),
        "hook_second": _resolve_number(metadata.get("hook_second")),
        "main_point_second": _resolve_number(metadata.get("main_point_second")),
        "punchline_second": _resolve_number(metadata.get("punchline_second")),
        "retention_level": _resolve_string(metadata.get("retention_level")),
        "requires_context": _resolve_boolean(metadata.get("requires_context")),
        "can_standalone": _resolve_boolean(metadata.get("can_standalone")),
    }


def _build_layout_options(
    *,
    layout_template: str | None,
    render_settings: dict[str, Any],
    candidate: Any,
    metadata: dict[str, Any],
    working_directory: Path,
    channel_name_path: Path,
    channel_tagline_path: Path,
    headline_path: Path,
    quote_path: Path,
    source_label_path: Path,
) -> dict[str, Any]:
    if layout_template != "PODCAST_SPOTLIGHT_9X16":
        return {}

    visual = render_settings.get("visual")
    visual_settings = visual.get("settings") if isinstance(visual, dict) else None
    branding = visual_settings.get("branding") if isinstance(visual_settings, dict) else None
    branding_data = branding if isinstance(branding, dict) else {}
    channel_name = _resolve_string(branding_data.get("channel_name")) or "Creator Studio"
    channel_tagline = _resolve_string(branding_data.get("channel_tagline"))
    source_label = f"Source: {channel_name}"
    headline = _normalize_headline_text(
        _resolve_string(metadata.get("thumbnail_text"))
        or _resolve_string(getattr(candidate, "title", None))
        or "Highlight clip"
    )
    quote = (
        _resolve_string(getattr(candidate, "hook_text", None))
        or _resolve_string(getattr(candidate, "ending_text", None))
        or _resolve_string(getattr(candidate, "summary", None))
        or _resolve_string(metadata.get("suggested_caption"))
        or headline
    )

    options = {
        "headline_size": _resolve_dynamic_font_size(headline, 112, 92, 74),
        "quote_size": _resolve_dynamic_font_size(quote, 64, 54, 44),
        "channel_name_size": 32,
        "channel_tagline_size": 24,
        "source_label_size": 28,
        "logo_source": _resolve_string(branding_data.get("logo_internal_url"))
        or _resolve_string(branding_data.get("logo_url")),
        "branding": {
            "channel_name": channel_name,
            "channel_tagline": channel_tagline,
            "brand_kit_name": _resolve_string(branding_data.get("brand_kit_name")),
            "logo_object_key": _resolve_string(branding_data.get("logo_object_key")),
        },
    }

    text_targets = [
        (channel_name_path, channel_name),
        (channel_tagline_path, channel_tagline),
        (headline_path, _wrap_overlay_text(headline, max_chars=16)),
        (quote_path, _wrap_overlay_text(quote, max_chars=22)),
        (source_label_path, source_label),
    ]
    key_map = {
        channel_name_path: "channel_name_file",
        channel_tagline_path: "channel_tagline_file",
        headline_path: "headline_file",
        quote_path: "quote_file",
        source_label_path: "source_label_file",
    }
    for path, text in text_targets:
        if not text:
            continue
        path.write_text(str(text), encoding="utf-8")
        options[key_map[path]] = str(path)

    return options


def _resolve_dynamic_font_size(text: str, short_size: int, medium_size: int, long_size: int) -> int:
    normalized_length = len(" ".join(text.split()))
    if normalized_length <= 28:
        return short_size
    if normalized_length <= 60:
        return medium_size
    return long_size


def _normalize_headline_text(text: str) -> str:
    normalized = " ".join(str(text).split()).strip()
    if not normalized:
        return "HIGHLIGHT CLIP"
    return normalized.upper()


def _wrap_overlay_text(text: str, *, max_chars: int) -> str:
    words = [word for word in str(text).split() if word]
    if not words:
        return ""
    lines: list[str] = []
    current: list[str] = []
    current_length = 0
    for word in words:
        projected = current_length + len(word) + (1 if current else 0)
        if current and projected > max_chars:
            lines.append(" ".join(current))
            current = [word]
            current_length = len(word)
        else:
            current.append(word)
            current_length = projected
    if current:
        lines.append(" ".join(current))
    return "\n".join(lines[:4])


def _resolve_string(value: Any) -> str | None:
    if isinstance(value, str):
        normalized = value.strip()
        return normalized or None
    return None


def _resolve_number(value: Any) -> float | int | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    return None


def _resolve_boolean(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    return None


def _build_validation_summary(
    *,
    aspect_ratio: str,
    width: int,
    height: int,
    expected_duration_ms: int,
    subtitle_format: str | None,
    final_observed: dict[str, Any],
    thumbnail_generated: bool,
    subtitle_generated: bool,
    subtitle_cue_count: int,
    preview_generated: bool,
) -> dict[str, Any]:
    observed_duration_ms = final_observed.get("duration_ms")
    observed_width = final_observed.get("width")
    observed_height = final_observed.get("height")
    observed_audio_codec = final_observed.get("audio_codec_name")
    observed_video_codec = final_observed.get("codec_name")
    observed_has_audio = bool(final_observed.get("has_audio"))
    duration_delta_ms = (
        abs(int(observed_duration_ms) - expected_duration_ms)
        if isinstance(observed_duration_ms, int)
        else None
    )
    checks = {
        "playable": isinstance(observed_duration_ms, int) and observed_duration_ms > 0,
        "resolution_matches_target": observed_width == width and observed_height == height,
        "audio_present": observed_has_audio,
        "video_codec_matches_target": str(observed_video_codec or "").lower() in {"h264", "avc1"},
        "audio_codec_matches_target": str(observed_audio_codec or "").lower() == "aac",
        "subtitle_export_ready": bool(subtitle_format),
        "duration_within_tolerance": duration_delta_ms is not None and duration_delta_ms <= 750,
        "preview_playable": True,
        "thumbnail_generated": thumbnail_generated,
        "subtitle_sidecar_generated": subtitle_generated,
        "subtitle_cues_present": subtitle_cue_count > 0 if subtitle_format else True,
    }
    warnings: list[str] = []
    if not checks["audio_present"]:
        warnings.append("Rendered clip does not expose an audio stream.")
    if not checks["resolution_matches_target"]:
        warnings.append("Rendered clip resolution does not match the requested aspect ratio target.")
    if not checks["duration_within_tolerance"]:
        warnings.append("Rendered clip duration differs from the candidate window beyond tolerance.")
    if subtitle_format and not checks["subtitle_sidecar_generated"]:
        warnings.append("Subtitle sidecar artifact was not generated.")
    return {
        "status": "passed" if all(checks.values()) else "needs_review",
        "checks": checks,
        "expected": {
            "aspect_ratio": aspect_ratio,
            "video_codec": "h264",
            "audio_codec": "aac",
            "pixel_format": "yuv420p",
            "container": "mp4",
            "fps": 30,
            "width": width,
            "height": height,
        },
        "observed": {
            "final": {
                **final_observed,
                "subtitle_format": subtitle_format,
            },
            "preview": None,
            "preview_generated": preview_generated,
            "thumbnail_generated": thumbnail_generated,
            "subtitle_generated": subtitle_generated,
            "subtitle_cue_count": subtitle_cue_count,
        },
        "warnings": warnings,
    }


def _resolve_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(str(value))
    except ValueError:
        return None


def _build_subtitle_cues(
    *,
    transcript_segments: list[TranscriptSegment],
    clip_start_seconds: float,
    clip_duration_seconds: float,
) -> list[SubtitleCue]:
    clip_end_seconds = clip_start_seconds + clip_duration_seconds
    words: list[tuple[float, float, str]] = []
    for segment in transcript_segments:
        if segment.words:
            for word in segment.words:
                if word.end_seconds <= clip_start_seconds or word.start_seconds >= clip_end_seconds:
                    continue
                words.append(
                    (
                        max(word.start_seconds, clip_start_seconds),
                        min(word.end_seconds, clip_end_seconds),
                        word.text.strip(),
                    )
                )
        elif segment.end_seconds > clip_start_seconds and segment.start_seconds < clip_end_seconds:
            words.append(
                (
                    max(segment.start_seconds, clip_start_seconds),
                    min(segment.end_seconds, clip_end_seconds),
                    segment.text.strip(),
                )
            )

    words = [entry for entry in words if entry[2]]
    if not words:
        return []

    cues: list[SubtitleCue] = []
    current_start: float | None = None
    current_end: float | None = None
    current_words: list[str] = []
    for start, end, text in words:
        if current_start is None:
            current_start = start
            current_end = end
            current_words = [text]
            continue

        current_end = max(current_end or end, end)
        current_words.append(text)
        if (
            len(current_words) >= 6
            or (current_end - current_start) >= 2.8
            or text.endswith((".", "!", "?", ","))
        ):
            cues.append(
                SubtitleCue(
                    start_seconds=max(0.0, current_start - clip_start_seconds),
                    end_seconds=max(0.1, current_end - clip_start_seconds),
                    text=_format_subtitle_text(current_words),
                )
            )
            current_start = None
            current_end = None
            current_words = []

    if current_start is not None and current_end is not None and current_words:
        cues.append(
            SubtitleCue(
                start_seconds=max(0.0, current_start - clip_start_seconds),
                end_seconds=max(0.1, current_end - clip_start_seconds),
                text=_format_subtitle_text(current_words),
            )
        )
    return cues


def _format_subtitle_text(words: list[str]) -> str:
    if not words:
        return ""

    max_words_per_line = 4
    max_chars_per_line = 26
    lines: list[str] = []
    current_line: list[str] = []
    current_length = 0

    for word in words:
        normalized = word.strip()
        if not normalized:
            continue
        projected_length = current_length + len(normalized) + (1 if current_line else 0)
        should_wrap = current_line and (
            len(current_line) >= max_words_per_line
            or projected_length > max_chars_per_line
        )

        if should_wrap and len(lines) < 1:
            lines.append(" ".join(current_line))
            current_line = [normalized]
            current_length = len(normalized)
            continue

        current_line.append(normalized)
        current_length = projected_length

    if current_line:
        lines.append(" ".join(current_line))

    if len(lines) <= 2:
        return "\n".join(lines)

    return "\n".join([lines[0], " ".join(lines[1:])])


def _render_srt(cues: list[SubtitleCue]) -> str:
    lines: list[str] = []
    for index, cue in enumerate(cues, start=1):
        lines.extend(
            [
                str(index),
                f"{_format_srt_timestamp(cue.start_seconds)} --> {_format_srt_timestamp(cue.end_seconds)}",
                cue.text,
                "",
            ]
        )
    return "\n".join(lines).strip() + "\n"


def _render_ass(cues: list[SubtitleCue]) -> str:
    header = [
        "[Script Info]",
        "ScriptType: v4.00+",
        "PlayResX: 1080",
        "PlayResY: 1920",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        "Style: Default,Arial,56,&H00FFFFFF,&H0000FFFF,&H00111111,&H66000000,1,0,0,0,100,100,0,0,1,3,0,2,64,64,80,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    events = [
        f"Dialogue: 0,{_format_ass_timestamp(cue.start_seconds)},{_format_ass_timestamp(cue.end_seconds)},Default,,0,0,0,,{_escape_ass_text(cue.text)}"
        for cue in cues
    ]
    return "\n".join([*header, *events]) + "\n"


def _render_vtt(cues: list[SubtitleCue]) -> str:
    lines = ["WEBVTT", ""]
    for cue in cues:
        lines.extend(
            [
                f"{_format_vtt_timestamp(cue.start_seconds)} --> {_format_vtt_timestamp(cue.end_seconds)}",
                cue.text,
                "",
            ]
        )
    return "\n".join(lines).strip() + "\n"


def _render_subtitle_json(cues: list[SubtitleCue]) -> str:
    payload = {
        "format": "json-timing-v1",
        "cue_count": len(cues),
        "cues": [
            {
                "start_seconds": round(cue.start_seconds, 3),
                "end_seconds": round(cue.end_seconds, 3),
                "text": cue.text,
            }
            for cue in cues
        ],
    }
    return json.dumps(payload, indent=2, ensure_ascii=True)


def _format_srt_timestamp(seconds: float) -> str:
    milliseconds = max(0, int(round(seconds * 1000)))
    hours = milliseconds // 3_600_000
    minutes = (milliseconds % 3_600_000) // 60_000
    secs = (milliseconds % 60_000) // 1000
    ms = milliseconds % 1000
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}"


def _format_ass_timestamp(seconds: float) -> str:
    centiseconds = max(0, int(round(seconds * 100)))
    hours = centiseconds // 360_000
    minutes = (centiseconds % 360_000) // 6_000
    secs = (centiseconds % 6_000) // 100
    cs = centiseconds % 100
    return f"{hours:d}:{minutes:02d}:{secs:02d}.{cs:02d}"


def _format_vtt_timestamp(seconds: float) -> str:
    milliseconds = max(0, int(round(seconds * 1000)))
    hours = milliseconds // 3_600_000
    minutes = (milliseconds % 3_600_000) // 60_000
    secs = (milliseconds % 60_000) // 1000
    ms = milliseconds % 1000
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{ms:03d}"


def _escape_ass_text(text: str) -> str:
    return text.replace("\\", r"\\").replace("{", r"\{").replace("}", r"\}")


async def _run_command(command: list[str], *, timeout_seconds: float) -> None:
    process = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        _stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout_seconds)
    except asyncio.TimeoutError:
        process.kill()
        await process.communicate()
        raise TimeoutError(f"command timed out: {command[0]}")
    if process.returncode != 0:
        message = stderr.decode("utf-8", errors="replace").strip() or "command exited with a non-zero status"
        raise RuntimeError(message)


async def _run_command_with_heartbeat(
    command: list[str],
    *,
    timeout_seconds: float,
    heartbeat_details: dict[str, Any],
    heartbeat_interval_seconds: int = 10,
) -> None:
    process = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    started_at = monotonic()

    while True:
        try:
            _stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=heartbeat_interval_seconds,
            )
            break
        except asyncio.TimeoutError:
            elapsed_seconds = monotonic() - started_at
            if elapsed_seconds >= timeout_seconds:
                process.kill()
                await process.communicate()
                raise TimeoutError(f"command timed out: {command[0]}")
            activity.heartbeat(
                {
                    **heartbeat_details,
                    "elapsed_seconds": int(elapsed_seconds),
                }
            )

    if process.returncode != 0:
        message = stderr.decode("utf-8", errors="replace").strip() or "command exited with a non-zero status"
        raise RuntimeError(message)


async def _generate_thumbnail(
    *,
    source: Path,
    destination: Path,
    timeout_seconds: float,
    heartbeat_details: dict[str, Any] | None = None,
) -> None:
    command = [
        "ffmpeg",
        "-hide_banner",
        "-nostdin",
        "-y",
        "-ss",
        "0.500",
        "-i",
        str(source),
        "-frames:v",
        "1",
        "-q:v",
        "2",
        str(destination),
    ]
    if heartbeat_details:
        await _run_command_with_heartbeat(
            command,
            timeout_seconds=timeout_seconds,
            heartbeat_details=heartbeat_details,
        )
    else:
        await _run_command(command, timeout_seconds=timeout_seconds)
    if not destination.exists():
        raise RuntimeError("ffmpeg completed without creating the thumbnail output")


def _summarize_render_probe(payload: dict[str, Any]) -> dict[str, Any]:
    from app.media.ffmpeg import summarize_ffprobe_payload

    summary = summarize_ffprobe_payload(payload)
    return {
        "duration_ms": summary.duration_ms,
        "width": summary.width,
        "height": summary.height,
        "frame_rate": summary.frame_rate,
        "audio_sample_rate": summary.audio_sample_rate,
        "codec_name": summary.codec_name,
        "audio_codec_name": summary.audio_codec_name,
        "rotation": summary.rotation,
        "has_audio": summary.has_audio,
    }


async def _upload_artifact(
    upload: ClipRenderArtifactUpload | None,
    path: Path | None,
    uploaded_artifacts: list[dict[str, Any]],
) -> str | None:
    if upload is None or path is None or not path.exists():
        return None
    await _upload_file(upload.upload_url, path, content_type=upload.content_type)
    uploaded_artifacts.append(
        {
            "artifact": upload.artifact,
            "object_key": upload.object_key,
            "content_type": upload.content_type,
            "size_bytes": path.stat().st_size,
        }
    )
    return upload.object_key


async def _upload_file(upload_url: str, path: Path, *, content_type: str) -> None:
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.put(
            str(upload_url),
            content=path.read_bytes(),
            headers={"content-type": content_type},
        )
        response.raise_for_status()


def _resolve_quality_status(status: str) -> str:
    if status == "passed":
        return "PASSED"
    if status == "failed":
        return "FAILED"
    return "NEEDS_REVIEW"
